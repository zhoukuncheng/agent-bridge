// The bridge's own agent contract. Slack code depends only on this, so a runtime
// can move between OAR and a direct protocol client without touching rendering.

export type TurnOutcome = "completed" | "aborted" | "failed";

export type AgentEvent =
  | { type: "turn_start" }
  | { type: "text"; text: string }
  /** Model reasoning; text is absent when the runtime redacts it. */
  | { type: "reasoning"; text?: string }
  | { type: "tool_start"; id: string; name: string; detail?: string }
  | { type: "tool_input"; id: string; detail: string }
  | { type: "tool_end"; id: string; ok?: boolean; output?: string }
  | { type: "turn_end"; outcome: TurnOutcome; error?: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number; contextUsed?: number; contextSize?: number; costUsd?: number }
  | { type: "model"; model: string }
  | { type: "exited"; code: number | null; reason?: string };

export type SendResult = "prompted" | "steered" | "queued";

export interface AgentSession {
  /** Native session id; persisted so the conversation can be resumed later. */
  readonly id: string;
  readonly agent: string;
  onEvent(listener: (event: AgentEvent) => void): () => void;
  /** Starts a turn when idle; otherwise steers into or queues behind the running turn. */
  send(text: string): Promise<SendResult>;
  abort(): Promise<void>;
  busy(): boolean;
  dispose(): Promise<void>;
}

export interface OpenOptions {
  cwd: string;
  model?: string;
  resume?: string;
  /** Read-only tools and no user configuration; only drivers that can enforce it accept it. */
  restricted?: boolean;
  /** With `restricted`: reads are allowed only under this directory (guests). */
  readRoot?: string;
}

export interface AgentDriver {
  readonly name: string;
  open(options: OpenOptions): Promise<AgentSession>;
}

/** Calls listeners in order and isolates their failures from the event source. */
export class Emitter {
  private listeners = new Set<(event: AgentEvent) => void>();

  on(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("agent event listener failed", err);
      }
    }
  }
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The bridge's own secrets: agents run arbitrary commands, so they never inherit these. */
export const bridgeSecretEnv = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"] as const;
