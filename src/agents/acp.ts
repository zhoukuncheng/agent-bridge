import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { scopeArgs } from "./memcap.ts";
import { bridgeSecretEnv, Emitter, truncate, type AgentDriver, type AgentEvent, type AgentSession, type OpenOptions, type SendResult } from "./types.ts";

// Minimal Agent Client Protocol client (https://agentclientprotocol.com) for agents
// OAR does not cover, such as omp. One subprocess per session, JSON-RPC over stdio.

export interface AcpAgentConfig {
  command: string;
  args?: string[];
  model?: string;
  env?: Record<string, string>;
  /** Run the agent inside a systemd scope with this memory cap, e.g. "8G". */
  memoryMax?: string;
}

type Json = Record<string, any>;

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

export class AcpConnection {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  onNotification: (method: string, params: Json) => void = () => {};
  onRequest: (method: string, params: Json) => Promise<unknown> = async (method) => {
    throw Object.assign(new Error(`method not supported: ${method}`), { code: -32601 });
  };
  onExit: (code: number | null) => void = () => {};
  stderrTail: string[] = [];

  private readonly child: ChildProcessWithoutNullStreams;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
    createInterface({ input: child.stderr }).on("line", (line) => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    });
    child.on("exit", (code) => {
      this.closed = true;
      const err = new Error(`agent process exited (${code})${this.stderrTail.length ? `: ${this.stderrTail.slice(-3).join(" | ")}` : ""}`);
      for (const pending of this.pending.values()) pending.reject(err);
      this.pending.clear();
      this.onExit(code);
    });
    child.on("error", (err) => {
      for (const pending of this.pending.values()) pending.reject(err);
      this.pending.clear();
    });
  }

  private write(message: Json): void {
    if (this.closed) throw new Error("agent process is not running");
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  request<T = any>(method: string, params: Json): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.write({ id, method, params });
      } catch (err) {
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  notify(method: string, params: Json): void {
    this.write({ method, params });
  }

  private handleLine(line: string): void {
    let message: Json;
    try {
      message = JSON.parse(line);
    } catch {
      return; // Agents may log non-protocol lines; ignore them.
    }
    if (message.method !== undefined && message.id !== undefined) {
      this.onRequest(message.method, message.params ?? {}).then(
        (result) => !this.closed && this.write({ id: message.id, result: result ?? null }),
        (err: Error & { code?: number }) => !this.closed && this.write({ id: message.id, error: { code: err.code ?? -32603, message: err.message } }),
      );
    } else if (message.method !== undefined) {
      this.onNotification(message.method, message.params ?? {});
    } else if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.error.message ?? "ACP error"} (${message.error.code})`));
      else pending.resolve(message.result);
    }
  }

  kill(): void {
    if (!this.closed) this.child.kill("SIGTERM");
  }
}

function contentText(content: unknown): string | undefined {
  const blocks = Array.isArray(content) ? content : content ? [content] : [];
  const texts = blocks.flatMap((block: any) => {
    if (block?.type === "text" && typeof block.text === "string") return [block.text];
    if (block?.type === "content") return contentText(block.content) ?? [];
    return [];
  });
  return texts.length ? texts.join("\n") : undefined;
}

function rawInputDetail(update: Json): string | undefined {
  const input = update.rawInput;
  if (input && typeof input === "object") {
    for (const key of ["command", "path", "file_path", "pattern", "url", "query", "description"]) {
      if (typeof input[key] === "string") return truncate(input[key].replace(/\s+/g, " "), 200);
    }
  }
  return undefined;
}

class AcpSession implements AgentSession {
  readonly emitter = new Emitter();
  private running = false;
  private queue: string[] = [];
  private replaying = false;
  private toolNames = new Map<string, string>();

  readonly agent: string;
  readonly id: string;
  private readonly conn: AcpConnection;

  constructor(agent: string, id: string, conn: AcpConnection) {
    this.agent = agent;
    this.id = id;
    this.conn = conn;
    conn.onNotification = (method, params) => {
      if (method === "session/update" && params.sessionId === this.id && !this.replaying) this.handleUpdate(params.update ?? {});
    };
    conn.onExit = (code) => {
      if (this.running) this.emitter.emit({ type: "turn_end", outcome: "failed", error: `agent exited (${code})` });
      this.running = false;
      this.emitter.emit({ type: "exited", code });
    };
  }

  setReplaying(value: boolean): void {
    this.replaying = value;
  }

  private handleUpdate(update: Json): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = contentText(update.content);
        if (text) this.emitter.emit({ type: "text", text });
        break;
      }
      case "agent_thought_chunk": {
        const text = contentText(update.content);
        this.emitter.emit({ type: "reasoning", ...(text ? { text } : {}) });
        break;
      }
      case "tool_call": {
        const name = String(update.title || update.name || update.kind || "tool");
        this.toolNames.set(update.toolCallId, name);
        this.emitter.emit({ type: "tool_start", id: update.toolCallId, name: truncate(name, 120), detail: rawInputDetail(update) });
        if (update.status === "completed" || update.status === "failed") this.emitTerminal(update);
        break;
      }
      case "tool_call_update":
        if (update.status === "completed" || update.status === "failed") this.emitTerminal(update);
        break;
      case "usage_update":
        this.emitter.emit({ type: "usage", contextUsed: update.used, contextSize: update.size, costUsd: update.cost?.currency === "USD" ? update.cost.amount : undefined });
        break;
      default:
        break;
    }
  }

  private emitTerminal(update: Json): void {
    const output = contentText(update.rawOutput?.content) ?? contentText(update.content);
    this.emitter.emit({ type: "tool_end", id: update.toolCallId, ok: update.status === "completed", output });
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    return this.emitter.on(listener);
  }

  async send(text: string): Promise<SendResult> {
    if (this.running) {
      this.queue.push(text);
      return "queued";
    }
    this.startTurn(text);
    return "prompted";
  }

  private startTurn(text: string): void {
    this.running = true;
    this.emitter.emit({ type: "turn_start" });
    this.conn
      .request("session/prompt", { sessionId: this.id, prompt: [{ type: "text", text }] })
      .then(
        (result: Json) => {
          const stop = result?.stopReason;
          if (result?.usage) this.emitter.emit({ type: "usage", inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens });
          this.finishTurn(stop === "cancelled" ? "aborted" : stop === "refusal" ? "failed" : "completed", stop === "refusal" ? "the model refused" : undefined);
        },
        (err: Error) => this.finishTurn("failed", err.message),
      );
  }

  private finishTurn(outcome: "completed" | "aborted" | "failed", error?: string): void {
    if (!this.running) return;
    this.running = false;
    this.emitter.emit({ type: "turn_end", outcome, ...(error ? { error } : {}) });
    if (this.queue.length) {
      const merged = this.queue.splice(0).join("\n\n");
      this.startTurn(merged);
    }
  }

  async abort(): Promise<void> {
    this.queue = [];
    if (this.running) this.conn.notify("session/cancel", { sessionId: this.id });
  }

  busy(): boolean {
    return this.running;
  }

  async dispose(): Promise<void> {
    this.queue = [];
    try {
      await Promise.race([this.conn.request("session/close", { sessionId: this.id }), new Promise((r) => setTimeout(r, 2000))]);
    } catch {
      // close is optional in ACP; the process is killed below either way.
    }
    this.conn.kill();
  }
}

/**
 * The bridge runs agents unattended, as cc-connect's yolo mode did: approve this one call.
 * Never picks allow_always (which would persist a grant) or an arbitrary option.
 */
export function choosePermission(options: Json[]): Json {
  const pick = options.find((o) => o.kind === "allow_once") ?? options.find((o) => o.kind === "allow");
  return pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" };
}

export class AcpDriver implements AgentDriver {
  readonly name: string;
  private readonly config: AcpAgentConfig;

  constructor(name: string, config: AcpAgentConfig) {
    this.name = name;
    this.config = config;
  }

  async open(options: OpenOptions): Promise<AgentSession> {
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.config.env };
    for (const name of bridgeSecretEnv) delete env[name];
    if (options.restricted) throw new Error(`${this.name} cannot run restricted sessions`);
    const [command, args] = this.config.memoryMax
      ? ["systemd-run", scopeArgs(this.config.memoryMax, this.config.command, this.config.args ?? [])]
      : [this.config.command, this.config.args ?? []];
    const child = spawn(command, args, {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const conn = new AcpConnection(child);
    conn.onRequest = async (method, params) => {
      if (method === "session/request_permission") {
        return { outcome: choosePermission(params.options ?? []) };
      }
      throw Object.assign(new Error(`method not supported: ${method}`), { code: -32601 });
    };
    try {
      const init: Json = await conn.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      const caps: Json = init?.agentCapabilities ?? {};
      let sessionId: string;
      let session: AcpSession;
      if (options.resume) {
        sessionId = options.resume;
        session = new AcpSession(this.name, sessionId, conn);
        const params = { sessionId, cwd: options.cwd, mcpServers: [] };
        if (caps.sessionCapabilities?.resume) {
          await conn.request("session/resume", params);
        } else if (caps.loadSession) {
          session.setReplaying(true); // load replays history as updates; don't re-post it.
          try {
            await conn.request("session/load", params);
          } finally {
            session.setReplaying(false);
          }
        } else {
          throw new Error(`${this.name} cannot resume sessions`);
        }
      } else {
        const created: Json = await conn.request("session/new", { cwd: options.cwd, mcpServers: [] });
        sessionId = created.sessionId;
        session = new AcpSession(this.name, sessionId, conn);
      }
      const model = options.model ?? this.config.model;
      if (model) await conn.request("session/set_config_option", { sessionId, configId: "model", value: model });
      return session;
    } catch (err) {
      conn.kill();
      throw err;
    }
  }
}
