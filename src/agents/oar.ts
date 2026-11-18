import { defaultRuntimes, type Event, type Runtime, type Session } from "@botiverse/oar";
import { Emitter, truncate, type AgentDriver, type AgentEvent, type AgentSession, type OpenOptions, type SendResult } from "./types.ts";

export interface OarAgentConfig {
  /** OAR runtime id: claude, codex, antigravity, pi, ... */
  runtime: string;
  model?: string;
  /** Native launch arguments; applied on every open, including resume (claude needs --permission-mode repeated). */
  launchArgs?: string[];
  env?: Record<string, string>;
}

/** Pulls the most useful field out of a tool's JSON arguments for a one-line summary. */
export function summarizeToolInput(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const input = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"]) {
      const value = input[key];
      if (typeof value === "string" && value.trim()) return truncate(value.trim().replace(/\s+/g, " "), 200);
    }
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return truncate(raw.replace(/\s+/g, " "), 200);
}

function toolOutputText(event: Extract<Event, { kind: "tool_call_ended" }>): string | undefined {
  const parts = (event.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : []));
  return parts.length ? parts.join("\n") : undefined;
}

class OarSession implements AgentSession {
  readonly id: string;
  private readonly emitter = new Emitter();
  private readonly unsubscribe: () => void;

  readonly agent: string;
  private readonly session: Session;

  constructor(agent: string, session: Session) {
    this.agent = agent;
    this.session = session;
    this.id = session.id;
    this.unsubscribe = session.events((event) => {
      const mapped = this.map(event);
      if (mapped) this.emitter.emit(mapped);
    }, { coalesceText: { maxHoldMs: 300 } });
  }

  private map(event: Event): AgentEvent | undefined {
    const root = event.agentPath.length === 0;
    switch (event.kind) {
      case "turn_started":
        return { type: "turn_start" };
      case "text_delta":
        return root ? { type: "text", text: event.text } : undefined;
      case "tool_call_started": {
        const name = root ? event.tool : `${event.agentPath.at(-1)} › ${event.tool}`;
        return { type: "tool_start", id: event.callId, name, detail: summarizeToolInput(event.input) };
      }
      case "tool_call_input":
        return { type: "tool_input", id: event.callId, detail: summarizeToolInput(event.input) ?? "" };
      case "tool_call_ended":
        return { type: "tool_end", id: event.callId, ok: event.result === undefined ? undefined : event.result === "ok", output: toolOutputText(event) };
      case "turn_ended":
        if (!root) return undefined;
        if (event.outcome.kind === "failed") return { type: "turn_end", outcome: "failed", error: `${event.outcome.failure}: ${event.outcome.reason}` };
        return { type: "turn_end", outcome: event.outcome.kind };
      case "usage": {
        if (!root) return undefined;
        const { tokens, context } = event.usage;
        return {
          type: "usage",
          inputTokens: tokens?.input,
          outputTokens: tokens?.output,
          contextUsed: context?.tokens ?? undefined,
          contextSize: context?.contextWindow ?? undefined,
        };
      }
      case "model":
        return root ? { type: "model", model: event.model } : undefined;
      case "exited":
        return { type: "exited", code: event.code, reason: event.reason };
      default:
        return undefined;
    }
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    return this.emitter.on(listener);
  }

  async send(text: string): Promise<SendResult> {
    const result = await this.session.deliver(text);
    if (result.landed === "rejected") throw new Error(`${this.agent} rejected the input: ${result.code} ${result.reason}`);
    return result.landed;
  }

  async abort(): Promise<void> {
    await this.session.abort();
  }

  busy(): boolean {
    return this.session.status().value.kind === "running";
  }

  async dispose(): Promise<void> {
    this.unsubscribe();
    await this.session.dispose();
  }
}

export class OarDriver implements AgentDriver {
  private runtime: Runtime;
  readonly name: string;
  private readonly config: OarAgentConfig;

  constructor(name: string, config: OarAgentConfig) {
    this.name = name;
    this.config = config;
    this.runtime = defaultRuntimes.require(config.runtime);
  }

  async open(options: OpenOptions): Promise<AgentSession> {
    const installation = await this.runtime.installation?.();
    if (!installation || installation.kind !== "available") {
      throw new Error(`${this.name}: runtime ${this.config.runtime} is not available (${installation?.kind ?? "no installation check"})`);
    }
    const model = options.model ?? this.config.model;
    const session = await this.runtime.session(installation, {
      cwd: options.cwd,
      ...(model ? { model } : {}),
      ...(options.resume ? { resume: options.resume } : {}),
      ...(this.config.launchArgs?.length ? { launchArgs: this.config.launchArgs } : {}),
      ...(this.config.env ? { env: this.config.env } : {}),
    });
    return new OarSession(this.name, session);
  }
}
