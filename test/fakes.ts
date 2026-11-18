import { Emitter, type AgentDriver, type AgentEvent, type AgentSession, type OpenOptions, type SendResult } from "../src/agents/types.ts";
import type { ReplyMessage, SlackApi, StreamChunk } from "../src/slack/api.ts";

export type SlackCall =
  | { method: "postMessage"; channel: string; thread_ts?: string; text: string; ts: string }
  | { method: "update"; channel: string; ts: string; text: string }
  | { method: "startStream"; channel: string; thread_ts: string; recipient_user_id?: string; ts: string }
  | { method: "appendStream"; channel: string; ts: string; chunks: StreamChunk[] }
  | { method: "stopStream"; channel: string; ts: string };

/** Records Slack calls; streams and posts get increasing fake timestamps. */
export class FakeSlack implements SlackApi {
  calls: SlackCall[] = [];
  private seq = 1;
  failStart = false;
  failAppendOnce = false;

  private nextTs(): string {
    return `1700000000.${String(this.seq++).padStart(6, "0")}`;
  }

  async postMessage(args: { channel: string; thread_ts?: string; text: string }) {
    const ts = this.nextTs();
    this.calls.push({ method: "postMessage", ...args, ts });
    return { ts };
  }
  async update(args: { channel: string; ts: string; text: string }) {
    this.calls.push({ method: "update", ...args });
  }
  async startStream(args: { channel: string; thread_ts: string; recipient_user_id?: string }) {
    if (this.failStart) throw new Error("not_allowed");
    const ts = this.nextTs();
    this.calls.push({ method: "startStream", channel: args.channel, thread_ts: args.thread_ts, recipient_user_id: args.recipient_user_id, ts });
    return { ts };
  }
  async appendStream(args: { channel: string; ts: string; chunks: StreamChunk[] }) {
    if (this.failAppendOnce) {
      this.failAppendOnce = false;
      throw new Error("message_not_in_streaming_state");
    }
    this.calls.push({ method: "appendStream", ...args });
  }
  async stopStream(args: { channel: string; ts: string }) {
    this.calls.push({ method: "stopStream", ...args });
  }
  async openDm(userId: string) {
    return `D${userId.slice(1)}`;
  }
  async replies(): Promise<ReplyMessage[]> {
    return [];
  }

  /** All markdown text streamed into the thread, plus posted/updated text. */
  textIn(threadTs: string): string {
    const streams = new Set(this.calls.filter((c) => c.method === "startStream" && c.thread_ts === threadTs).map((c) => (c as { ts: string }).ts));
    const parts: string[] = [];
    for (const c of this.calls) {
      if (c.method === "appendStream" && streams.has(c.ts)) for (const chunk of c.chunks) if (chunk.type === "markdown_text") parts.push(chunk.text);
      if (c.method === "postMessage" && c.thread_ts === threadTs) parts.push(c.text);
    }
    return parts.join("");
  }

  posts(threadTs?: string) {
    return this.calls.filter((c): c is Extract<SlackCall, { method: "postMessage" }> => c.method === "postMessage" && (threadTs === undefined || c.thread_ts === threadTs));
  }
}

/**
 * A scripted agent: replies "echo: <input>" after a tick. Input containing "HANG"
 * runs until aborted; "TOOL" emits a tool call first; "FAIL" ends the turn failed.
 */
export class FakeSession implements AgentSession {
  readonly emitter = new Emitter();
  readonly inputs: string[] = [];
  running = false;
  disposed = false;
  private queue: string[] = [];
  readonly id: string;
  readonly agent: string;
  readonly resumedFrom: string | undefined;

  constructor(agent: string, id: string, resumedFrom?: string) {
    this.agent = agent;
    this.id = id;
    this.resumedFrom = resumedFrom;
  }

  onEvent(listener: (event: AgentEvent) => void) {
    return this.emitter.on(listener);
  }

  async send(text: string): Promise<SendResult> {
    this.inputs.push(text);
    if (this.running) {
      this.queue.push(text);
      return "queued";
    }
    this.start(text);
    return "prompted";
  }

  private start(text: string): void {
    this.running = true;
    this.emitter.emit({ type: "turn_start" });
    if (text.includes("HANG")) return;
    setTimeout(() => {
      if (text.includes("TOOL")) {
        this.emitter.emit({ type: "tool_start", id: "call-1", name: "Bash", detail: "echo hi" });
        this.emitter.emit({ type: "tool_end", id: "call-1", ok: true, output: "hi" });
      }
      this.emitter.emit({ type: "text", text: `echo: ${text}` });
      this.end(text.includes("FAIL") ? "failed" : "completed", text.includes("FAIL") ? "boom" : undefined);
    }, 5);
  }

  private end(outcome: "completed" | "aborted" | "failed", error?: string): void {
    this.running = false;
    this.emitter.emit({ type: "turn_end", outcome, ...(error ? { error } : {}) });
    const next = this.queue.shift();
    if (next !== undefined) this.start(next);
  }

  async abort() {
    if (this.running) setTimeout(() => this.end("aborted"), 1);
  }

  busy() {
    return this.running;
  }

  async dispose() {
    this.disposed = true;
  }
}

export class FakeDriver implements AgentDriver {
  sessions: FakeSession[] = [];
  opens: OpenOptions[] = [];
  private n = 0;
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  async open(options: OpenOptions): Promise<AgentSession> {
    this.opens.push(options);
    const session = new FakeSession(this.name, options.resume ?? `${this.name}-session-${++this.n}`, options.resume);
    this.sessions.push(session);
    return session;
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
