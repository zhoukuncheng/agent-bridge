import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { WebClient } from "@slack/web-api";

export type StreamChunk =
  | { type: "markdown_text"; text: string }
  | { type: "task_update"; id: string; title: string; status: "pending" | "in_progress" | "complete" | "error"; details?: string; output?: string };

export interface SlackFile {
  id: string;
  name: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
}

export interface ReplyMessage {
  ts: string;
  text: string;
  user?: string;
  bot_id?: string;
  blocks?: unknown[];
  thread_ts?: string;
  subtype?: string;
  files?: SlackFile[];
}

/** Accepts only https URLs on slack.com hosts. */
export function slackFileUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" || !(url.hostname === "slack.com" || url.hostname.endsWith(".slack.com"))) {
    throw new Error(`refusing to send the bot token to ${url.protocol}//${url.hostname}`);
  }
  return url.toString();
}

const toReply = (m: Record<string, any>): ReplyMessage => ({
  ts: m.ts,
  text: m.text ?? "",
  user: m.user,
  bot_id: m.bot_id,
  blocks: m.blocks,
  thread_ts: m.thread_ts,
  subtype: m.subtype,
  files: m.files,
});

/** The slice of the Slack Web API the bridge uses; tests substitute a recorder. */
export interface SlackApi {
  postMessage(args: { channel: string; thread_ts?: string; text: string }): Promise<{ ts: string }>;
  update(args: { channel: string; ts: string; text: string }): Promise<void>;
  startStream(args: { channel: string; thread_ts: string; recipient_user_id?: string; recipient_team_id?: string }): Promise<{ ts: string }>;
  appendStream(args: { channel: string; ts: string; chunks: StreamChunk[] }): Promise<void>;
  stopStream(args: { channel: string; ts: string }): Promise<void>;
  openDm(userId: string): Promise<string>;
  replies(channel: string, ts: string): Promise<ReplyMessage[]>;
  /** Display name for a user id; falls back to the id. */
  userName(userId: string): Promise<string>;
  /** Top-level messages in a channel newer than `oldestTs`, oldest first. */
  history(channel: string, oldestTs: string): Promise<ReplyMessage[]>;
  /** Downloads a private file with the bot token; returns its size. Throws above maxBytes. */
  downloadFile(file: SlackFile, dest: string, maxBytes: number): Promise<number>;
}

export class WebSlackApi implements SlackApi {
  private readonly client: WebClient;
  private readonly names = new Map<string, string>();

  constructor(client: WebClient) {
    this.client = client;
  }

  async postMessage(args: { channel: string; thread_ts?: string; text: string }): Promise<{ ts: string }> {
    const result = await this.client.chat.postMessage({ ...args, unfurl_links: false, unfurl_media: false });
    return { ts: result.ts! };
  }

  async update(args: { channel: string; ts: string; text: string }): Promise<void> {
    await this.client.chat.update(args);
  }

  async startStream(args: { channel: string; thread_ts: string; recipient_user_id?: string; recipient_team_id?: string }): Promise<{ ts: string }> {
    const result = await this.client.chat.startStream({ ...args, task_display_mode: "timeline" });
    return { ts: result.ts! };
  }

  async appendStream(args: { channel: string; ts: string; chunks: StreamChunk[] }): Promise<void> {
    // Once a stream carries chunks it must keep using chunks; mixing in markdown_text fails with streaming_mode_mismatch.
    await this.client.chat.appendStream(args);
  }

  async stopStream(args: { channel: string; ts: string }): Promise<void> {
    await this.client.chat.stopStream(args);
  }

  async openDm(userId: string): Promise<string> {
    const result = await this.client.conversations.open({ users: userId });
    return result.channel!.id!;
  }

  async replies(channel: string, ts: string): Promise<ReplyMessage[]> {
    const messages: ReplyMessage[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.conversations.replies({ channel, ts, cursor, limit: 200 });
      for (const m of page.messages ?? []) messages.push(toReply(m));
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return messages;
  }

  async userName(userId: string): Promise<string> {
    const cached = this.names.get(userId);
    if (cached) return cached;
    let name = userId;
    try {
      const result = await this.client.users.info({ user: userId });
      name = result.user?.profile?.display_name || result.user?.real_name || result.user?.name || userId;
    } catch {
      // users:read missing or user gone: keep the id.
    }
    this.names.set(userId, name);
    return name;
  }

  async history(channel: string, oldestTs: string): Promise<ReplyMessage[]> {
    const messages: ReplyMessage[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.conversations.history({ channel, oldest: oldestTs, cursor, limit: 200 });
      for (const m of page.messages ?? []) messages.push(toReply(m));
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return messages.sort((a, b) => Number(a.ts) - Number(b.ts));
  }

  async downloadFile(file: SlackFile, dest: string, maxBytes: number): Promise<number> {
    if (!file.url_private_download) throw new Error(`${file.name}: no download URL (external or deleted file)`);
    if (file.size !== undefined && file.size > maxBytes) throw new Error(`${file.name} is ${Math.round(file.size / 1e6)} MB, over the ${Math.round(maxBytes / 1e6)} MB limit`);
    // The bot token goes only to Slack's own HTTPS hosts, also across redirects.
    let url = slackFileUrl(file.url_private_download);
    let res: Response | undefined;
    for (let hop = 0; hop < 4; hop++) {
      res = await fetch(url, { headers: { Authorization: `Bearer ${this.client.token}` }, redirect: "manual" });
      if (res.status < 300 || res.status >= 400) break;
      const next = res.headers.get("location");
      if (!next) break;
      url = slackFileUrl(new URL(next, url).toString());
    }
    if (!res || !res.ok || !res.body) throw new Error(`${file.name}: download failed (${res?.status})`);
    let size = 0;
    const body = Readable.fromWeb(res.body as never);
    body.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) body.destroy(new Error(`${file.name} is over the ${Math.round(maxBytes / 1e6)} MB limit`));
    });
    await pipeline(body, createWriteStream(dest, { mode: 0o600 }));
    return size;
  }
}
