import type { WebClient } from "@slack/web-api";

export type StreamChunk =
  | { type: "markdown_text"; text: string }
  | { type: "task_update"; id: string; title: string; status: "pending" | "in_progress" | "complete" | "error"; details?: string; output?: string };

export interface ReplyMessage {
  ts: string;
  text: string;
  user?: string;
  bot_id?: string;
  blocks?: unknown[];
}

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
      for (const m of page.messages ?? []) messages.push({ ts: m.ts!, text: m.text ?? "", user: m.user, bot_id: m.bot_id, blocks: m.blocks });
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
}
