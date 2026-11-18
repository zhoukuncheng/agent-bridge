import { truncate, type AgentEvent, type TurnOutcome } from "../agents/types.ts";
import type { SlackApi, StreamChunk } from "./api.ts";

export interface ThreadTarget {
  channel: string;
  threadTs: string;
  /** Required by chat.startStream outside DMs: the user the stream is addressed to. */
  recipientUserId?: string;
  teamId?: string;
}

export type DisplayMode = "concise" | "verbose";

export interface RenderOptions {
  display: DisplayMode;
  flushMs: number;
  /** Start a new message once a streamed message holds this many characters of text. */
  rolloverChars: number;
  /** Fallback (chat.update) message size before rolling over. */
  fallbackChars: number;
  /** Concise: text not followed by a tool call within this long is the answer, not narration. */
  holdMs: number;
  /** Concise: held text longer than this is the answer. */
  holdChars: number;
  /** Concise: minimum gap between progress card updates. */
  cardMs: number;
}

const defaults: RenderOptions = { display: "concise", flushMs: 700, rolloverChars: 10_000, fallbackChars: 3_500, holdMs: 2_500, holdChars: 1_500, cardMs: 800 };

type TaskStatus = "in_progress" | "complete" | "error";

/** A task card inside the current streamed message; Slack scopes task ids to one message. */
interface Card {
  taskId: string;
  stream: number;
}

interface Step {
  name: string;
  detail?: string;
  status: TaskStatus;
}

interface ToolState extends Card {
  title: string;
  detail?: string;
}

const outcomeIcon: Record<TurnOutcome, string> = { completed: "✅", aborted: "⏹️", failed: "❌" };
const stepIcon: Record<TaskStatus, string> = { in_progress: "…", complete: "✓", error: "✗" };

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

const lastLine = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1) ?? "";

/**
 * Renders one agent turn into Slack as a native streaming message.
 * - verbose: one timeline task card per tool call, then the text as it streams.
 * - concise: every tool call and the narration around them fold into one progress card;
 *   only the answer streams as text.
 * Falls back to post + chat.update when streaming is unavailable. All Slack calls run on
 * one promise chain to keep their order.
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

  // concise state
  private held = "";
  private holdTimer: NodeJS.Timeout | undefined;
  private answering = false;
  private steps: Step[] = [];
  private stepIndex = new Map<string, number>();
  private narration = "";
  private thinking = "";
  private card: Card | undefined;
  private cardTimer: NodeJS.Timeout | undefined;

  constructor(api: SlackApi, target: ThreadTarget, options: Partial<RenderOptions> = {}) {
    this.api = api;
    this.target = target;
    this.options = { ...defaults, ...options };
  }

  private get concise(): boolean {
    return this.options.display === "concise";
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
        if (this.concise && !this.answering) this.hold(event.text);
        else this.queueText(event.text);
        break;
      case "reasoning":
        if (this.concise && event.text && !this.answering) {
          this.thinking = lastLine(event.text);
          this.markCard();
        }
        break;
      case "tool_start":
        if (this.concise) this.conciseToolStart(event.id, event.name, event.detail);
        else {
          this.flushText(true);
          const state: ToolState = { title: truncate(event.name, 150), detail: event.detail, taskId: "", stream: -1 };
          this.tools.set(event.id, state);
          this.enqueue(() => this.sendTask(state, "in_progress"));
        }
        break;
      case "tool_input": {
        if (!event.detail) break;
        if (this.concise) {
          const i = this.stepIndex.get(event.id);
          if (i !== undefined) {
            this.steps[i]!.detail = event.detail;
            this.markCard();
          }
          break;
        }
        const state = this.tools.get(event.id);
        if (!state) break;
        state.detail = event.detail;
        this.enqueue(() => this.sendTask(state, "in_progress"));
        break;
      }
      case "tool_end": {
        const status: TaskStatus = event.ok === false ? "error" : "complete";
        if (this.concise) {
          const i = this.stepIndex.get(event.id);
          if (i !== undefined) {
            this.steps[i]!.status = status;
            this.markCard();
          }
          break;
        }
        const state = this.tools.get(event.id);
        if (!state) break;
        const output = event.output ? truncate(event.output.trim(), 400) : undefined;
        this.enqueue(() => this.sendTask(state, status, output));
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

  // --- concise: narration vs answer -------------------------------------------------

  private hold(text: string): void {
    this.held += text;
    if (this.holdTimer) clearTimeout(this.holdTimer);
    if (this.held.length > this.options.holdChars) return this.promoteHeld();
    this.holdTimer = setTimeout(() => this.promoteHeld(), this.options.holdMs);
  }

  /** Held text that no tool call followed is part of the answer: stream it. */
  private promoteHeld(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
    this.answering = true;
    const text = this.held;
    this.held = "";
    if (text) this.queueText(text);
  }

  private conciseToolStart(id: string, name: string, detail?: string): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
    if (this.answering) {
      // The answer so far stays; what comes next is a new round of work.
      this.flushText(true);
      this.answering = false;
    } else if (this.held.trim()) {
      this.narration = lastLine(this.held);
    }
    this.held = "";
    this.stepIndex.set(id, this.steps.length);
    this.steps.push({ name: truncate(name, 60), detail, status: "in_progress" });
    this.markCard();
  }

  private cardTitle(final?: TurnOutcome): string {
    if (final && !this.steps.length) return "💭 thought it through";
    if (final) {
      const counts = new Map<string, number>();
      for (const s of this.steps) counts.set(s.name, (counts.get(s.name) ?? 0) + 1);
      const top = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([n, c]) => (c > 1 ? `${n} ×${c}` : n))
        .join(", ");
      return truncate(`${this.steps.length} step${this.steps.length === 1 ? "" : "s"}${top ? ` · ${top}` : ""}`, 150);
    }
    if (this.narration) return truncate(this.narration, 150);
    if (this.thinking) return truncate(`💭 ${this.thinking}`, 150);
    return "Working…";
  }

  private cardDetails(): string | undefined {
    if (!this.steps.length) return undefined;
    const shown = this.steps.slice(-8);
    const lines = shown.map((s) => `${stepIcon[s.status]} ${s.name}${s.detail ? `  ${truncate(s.detail.replace(/\s+/g, " "), 90)}` : ""}`);
    if (this.steps.length > shown.length) lines.unshift(`… ${this.steps.length - shown.length} earlier`);
    return truncate(lines.join("\n"), 1200);
  }

  private markCard(): void {
    if (this.cardTimer) return;
    this.cardTimer = setTimeout(() => {
      this.cardTimer = undefined;
      this.enqueue(() => this.sendCard());
    }, this.options.cardMs);
  }

  private async sendCard(final?: TurnOutcome): Promise<void> {
    if (!this.steps.length && !this.thinking) return;
    await this.ensureStarted();
    if (this.mode !== "stream") return; // the fallback message shows the step summary at the end
    if (!this.card || this.card.stream !== this.streamIndex) this.card = { taskId: `t${this.nextTask++}`, stream: this.streamIndex };
    const failed = this.steps.some((s) => s.status === "error");
    const status: TaskStatus = final ? (final === "completed" ? "complete" : "error") : "in_progress";
    const chunk: StreamChunk = { type: "task_update", id: this.card.taskId, title: this.cardTitle(final), status };
    const details = this.cardDetails();
    if (details) chunk.details = details;
    if (final && failed && final === "completed") chunk.output = "some steps failed";
    await this.append([chunk], true);
  }

  // --- shared ------------------------------------------------------------------------

  private queueText(text: string): void {
    this.pending += text;
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.flushText(false);
    }, this.options.flushMs);
  }

  /** Flushes everything, writes the footer and closes the message. */
  finish(outcome: TurnOutcome, error?: string): Promise<void> {
    if (this.finished) return this.chain;
    if (this.timer) clearTimeout(this.timer);
    if (this.holdTimer) clearTimeout(this.holdTimer);
    if (this.cardTimer) clearTimeout(this.cardTimer);
    this.timer = this.holdTimer = this.cardTimer = undefined;
    if (this.held) {
      this.pending += this.held;
      this.held = "";
    }
    if (this.concise && (this.steps.length || this.thinking)) {
      this.enqueue(() => this.sendCard(outcome));
      if (this.steps.length) this.fallbackSummary();
    }
    this.flushText(true);
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

  private fallbackSummary(): void {
    this.enqueue(async () => {
      if (this.mode === "fallback") this.fallbackBody = `_${this.cardTitle("completed")}_\n${this.fallbackBody}`;
    });
  }

  /**
   * Sends pending text. Unless `all`, it stops at the last whitespace so a credential is
   * never split across two appends, where the redactor could not recognise either half.
   */
  private flushText(all: boolean): void {
    if (!this.pending) return;
    let cut = this.pending.length;
    if (!all) {
      const ws = Math.max(this.pending.lastIndexOf(" "), this.pending.lastIndexOf("\n"), this.pending.lastIndexOf("\t"));
      if (ws >= 0) cut = ws + 1;
      else if (this.pending.length < 2_000) cut = 0;
    }
    if (cut === 0) {
      this.timer ??= setTimeout(() => {
        this.timer = undefined;
        this.flushText(false);
      }, this.options.flushMs);
      return;
    }
    const text = this.pending.slice(0, cut);
    this.pending = this.pending.slice(cut);
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

  private async append(chunks: StreamChunk[], isCard = false): Promise<void> {
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
      const moved = isCard && this.card ? chunks.map((c) => (c.type === "task_update" ? { ...c, id: this.recard().taskId } : c)) : chunks.map((c) => this.retarget(c));
      await this.api.appendStream({ channel: this.target.channel, ts: this.streamTs!, chunks: moved });
    }
  }

  private recard(): Card {
    this.card = { taskId: `t${this.nextTask++}`, stream: this.streamIndex };
    return this.card;
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

  private async sendTask(state: ToolState, status: TaskStatus, output?: string): Promise<void> {
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
