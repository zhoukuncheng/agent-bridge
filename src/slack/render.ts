import { truncate, type AgentEvent, type TurnOutcome } from "../agents/types.ts";
import type { SlackApi, StreamChunk } from "./api.ts";

export interface ThreadTarget {
  channel: string;
  threadTs: string;
  /** Required by chat.startStream outside DMs: the user the stream is addressed to. */
  recipientUserId?: string;
  teamId?: string;
}

export interface RenderOptions {
  flushMs: number;
  /** Start a new message once a streamed message holds this many characters of text. */
  rolloverChars: number;
  /** Fallback (chat.update) message size before rolling over. */
  fallbackChars: number;
}

const defaults: RenderOptions = { flushMs: 700, rolloverChars: 10_000, fallbackChars: 3_500 };

interface ToolState {
  title: string;
  detail?: string;
  /** Short id inside the stream the card was created in; Slack scopes task ids to one message. */
  taskId: string;
  stream: number;
}

const outcomeIcon: Record<TurnOutcome, string> = { completed: "✅", aborted: "⏹️", failed: "❌" };

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/**
 * Renders one agent turn into Slack: one native streaming message with tool calls as
 * timeline task cards and the answer as markdown. Falls back to post + chat.update when
 * streaming is unavailable. All Slack calls run on one promise chain to keep order.
 */
export class TurnRenderer {
  private chain: Promise<void> = Promise.resolve();
  private pending = "";
  private timer: NodeJS.Timeout | undefined;
  private mode: "stream" | "fallback" | undefined;
  private streamTs: string | undefined;
  private streamIndex = 0;
  private streamedChars = 0;
  private nextTask = 1;
  private tools = new Map<string, ToolState>();
  private fallbackTs: string | undefined;
  private fallbackBody = "";
  private fallbackDirty = false;
  private lastFallbackUpdate = 0;
  private model: string | undefined;
  private context: { used?: number; size?: number } = {};
  private costUsd: number | undefined;
  private readonly startedAt = Date.now();
  private finished = false;
  readonly errors: string[] = [];
  private readonly options: RenderOptions;

  private readonly api: SlackApi;
  private readonly target: ThreadTarget;

  constructor(api: SlackApi, target: ThreadTarget, options: Partial<RenderOptions> = {}) {
    this.api = api;
    this.target = target;
    this.options = { ...defaults, ...options };
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(op).catch((err: Error) => {
      this.errors.push(err.message);
      console.error("slack render failed", err);
    });
    return this.chain;
  }

  handle(event: AgentEvent): void {
    if (this.finished) return;
    switch (event.type) {
      case "text":
        this.pending += event.text;
        this.timer ??= setTimeout(() => {
          this.timer = undefined;
          this.flushText();
        }, this.options.flushMs);
        break;
      case "tool_start": {
        this.flushText();
        const state: ToolState = { title: truncate(event.name, 150), detail: event.detail, taskId: "", stream: -1 };
        this.tools.set(event.id, state);
        this.enqueue(() => this.sendTask(state, "in_progress"));
        break;
      }
      case "tool_input": {
        const state = this.tools.get(event.id);
        if (!state || !event.detail) break;
        state.detail = event.detail;
        this.enqueue(() => this.sendTask(state, "in_progress"));
        break;
      }
      case "tool_end": {
        const state = this.tools.get(event.id);
        if (!state) break;
        const output = event.output ? truncate(event.output.trim(), 400) : undefined;
        this.enqueue(() => this.sendTask(state, event.ok === false ? "error" : "complete", output));
        break;
      }
      case "model":
        this.model = event.model;
        break;
      case "usage":
        if (event.contextUsed !== undefined) this.context = { used: event.contextUsed, size: event.contextSize };
        if (event.costUsd !== undefined) this.costUsd = event.costUsd;
        break;
      default:
        break;
    }
  }

  /** Flushes everything, writes the footer and closes the message. */
  finish(outcome: TurnOutcome, error?: string): Promise<void> {
    if (this.finished) return this.chain;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.flushText();
    this.finished = true;
    const parts = [`${outcomeIcon[outcome]} ${outcome}`, formatDuration(Date.now() - this.startedAt)];
    if (this.model) parts.push(this.model);
    if (this.context.used && this.context.size) parts.push(`ctx ${Math.round((this.context.used / this.context.size) * 100)}%`);
    if (this.costUsd !== undefined) parts.push(`$${this.costUsd.toFixed(3)}`);
    let footer = `_${parts.join(" · ")}_`;
    if (error) footer += `\n> ${truncate(error.replace(/\n/g, " "), 500)}`;
    this.enqueue(() => this.appendText(`\n\n${footer}`));
    return this.enqueue(async () => {
      if (this.mode === "stream" && this.streamTs) await this.api.stopStream({ channel: this.target.channel, ts: this.streamTs });
      if (this.mode === "fallback") await this.updateFallback(true);
    });
  }

  private flushText(): void {
    if (!this.pending) return;
    const text = this.pending;
    this.pending = "";
    this.enqueue(() => this.appendText(text));
  }

  private async ensureStarted(): Promise<void> {
    if (this.mode === "fallback" || this.streamTs) return;
    try {
      const { ts } = await this.api.startStream({
        channel: this.target.channel,
        thread_ts: this.target.threadTs,
        ...(this.target.recipientUserId ? { recipient_user_id: this.target.recipientUserId, recipient_team_id: this.target.teamId } : {}),
      });
      this.mode = "stream";
      this.streamTs = ts;
      this.streamedChars = 0;
    } catch (err) {
      console.warn("chat.startStream failed, falling back to chat.update", (err as Error).message);
      this.mode = "fallback";
    }
  }

  private async append(chunks: StreamChunk[]): Promise<void> {
    await this.ensureStarted();
    if (this.mode !== "stream") return;
    try {
      await this.api.appendStream({ channel: this.target.channel, ts: this.streamTs!, chunks });
    } catch (err) {
      // A stream can end under us (expired or stopped elsewhere): continue in a fresh message once.
      console.warn("chat.appendStream failed, starting a new stream", (err as Error).message);
      this.streamTs = undefined;
      this.streamIndex++;
      await this.ensureStarted();
      if (this.mode !== "stream") return;
      await this.api.appendStream({ channel: this.target.channel, ts: this.streamTs!, chunks: chunks.map((c) => this.retarget(c)) });
    }
  }

  private retarget(chunk: StreamChunk): StreamChunk {
    if (chunk.type !== "task_update") return chunk;
    for (const state of this.tools.values()) {
      if (state.taskId === chunk.id && state.stream !== this.streamIndex) {
        state.taskId = `t${this.nextTask++}`;
        state.stream = this.streamIndex;
        return { ...chunk, id: state.taskId };
      }
    }
    return chunk;
  }

  private async rollover(): Promise<void> {
    if (this.streamTs) await this.api.stopStream({ channel: this.target.channel, ts: this.streamTs });
    this.streamTs = undefined;
    this.streamIndex++;
  }

  private async sendTask(state: ToolState, status: "in_progress" | "complete" | "error", output?: string): Promise<void> {
    await this.ensureStarted();
    if (this.mode === "fallback") {
      const icon = status === "in_progress" ? "⏳" : status === "complete" ? "✓" : "✗";
      this.fallbackBody += `\n${icon} \`${state.title}\`${state.detail ? ` ${truncate(state.detail, 120)}` : ""}`;
      return this.updateFallback(false);
    }
    if (state.stream !== this.streamIndex) {
      state.taskId = `t${this.nextTask++}`;
      state.stream = this.streamIndex;
    }
    const chunk: StreamChunk = { type: "task_update", id: state.taskId, title: state.title, status };
    if (state.detail) chunk.details = truncate(state.detail, 300);
    if (output) chunk.output = output;
    await this.append([chunk]);
  }

  private async appendText(text: string): Promise<void> {
    await this.ensureStarted();
    if (this.mode === "fallback") {
      this.fallbackBody += text;
      return this.updateFallback(false);
    }
    if (this.streamedChars > 0 && this.streamedChars + text.length > this.options.rolloverChars) await this.rollover();
    for (let i = 0; i < text.length; i += this.options.rolloverChars) {
      const piece = text.slice(i, i + this.options.rolloverChars);
      if (i > 0) await this.rollover();
      await this.append([{ type: "markdown_text", text: piece }]);
      this.streamedChars += piece.length;
    }
  }

  private async updateFallback(force: boolean): Promise<void> {
    this.fallbackDirty = true;
    while (this.fallbackBody.length > this.options.fallbackChars) {
      const head = this.fallbackBody.slice(0, this.options.fallbackChars);
      this.fallbackBody = this.fallbackBody.slice(this.options.fallbackChars);
      if (this.fallbackTs) await this.api.update({ channel: this.target.channel, ts: this.fallbackTs, text: head });
      else await this.api.postMessage({ channel: this.target.channel, thread_ts: this.target.threadTs, text: head });
      this.fallbackTs = undefined;
    }
    if (!force && Date.now() - this.lastFallbackUpdate < 1000) return;
    if (!this.fallbackDirty || !this.fallbackBody.trim()) return;
    this.lastFallbackUpdate = Date.now();
    this.fallbackDirty = false;
    if (this.fallbackTs) await this.api.update({ channel: this.target.channel, ts: this.fallbackTs, text: this.fallbackBody });
    else this.fallbackTs = (await this.api.postMessage({ channel: this.target.channel, thread_ts: this.target.threadTs, text: this.fallbackBody })).ts;
  }
}
