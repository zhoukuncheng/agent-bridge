import type { AgentEvent, AgentSession, TurnOutcome } from "../agents/types.ts";
import type { SlackApi } from "../slack/api.ts";
import { TurnRenderer, type RenderOptions, type ThreadTarget } from "../slack/render.ts";

export interface TurnResult {
  outcome: TurnOutcome;
  error?: string;
}

/** Connects one agent session to one Slack thread: each turn gets its own renderer. */
export class SessionBinding {
  private renderer: TurnRenderer | undefined;
  private waiters: ((result: TurnResult) => void)[] = [];
  private readonly unsubscribe: () => void;
  lastActive = Date.now();
  exited = false;
  onExit: () => void = () => {};

  readonly session: AgentSession;
  private readonly api: SlackApi;
  readonly target: ThreadTarget;
  private readonly renderOptions: Partial<RenderOptions>;

  constructor(session: AgentSession, api: SlackApi, target: ThreadTarget, renderOptions: Partial<RenderOptions> = {}) {
    this.session = session;
    this.api = api;
    this.target = target;
    this.renderOptions = renderOptions;
    this.unsubscribe = session.onEvent((event) => this.handle(event));
  }

  private current(): TurnRenderer {
    this.renderer ??= new TurnRenderer(this.api, this.target, this.renderOptions);
    return this.renderer;
  }

  private handle(event: AgentEvent): void {
    this.lastActive = Date.now();
    switch (event.type) {
      case "turn_start":
        this.current();
        break;
      case "turn_end":
        this.endTurn({ outcome: event.outcome, error: event.error });
        break;
      case "exited":
        this.exited = true;
        if (this.renderer) this.endTurn({ outcome: "failed", error: `agent process exited (${event.code})${event.reason ? `: ${event.reason}` : ""}` });
        this.onExit();
        break;
      case "usage":
      case "model":
        // Metadata only: don't open a message for it, but let an active turn's footer use it.
        this.renderer?.handle(event);
        break;
      default:
        this.current().handle(event);
    }
  }

  private endTurn(result: TurnResult): void {
    const renderer = this.current();
    this.renderer = undefined;
    void renderer.finish(result.outcome, result.error).then(() => {
      const waiters = this.waiters.splice(0);
      for (const resolve of waiters) resolve(result);
    });
  }

  /** Resolves when the next turn ends and its message is finalized in Slack. */
  nextTurnEnd(): Promise<TurnResult> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async send(text: string) {
    this.lastActive = Date.now();
    return this.session.send(text);
  }

  async dispose(): Promise<void> {
    this.unsubscribe();
    if (this.renderer) await this.renderer.finish("aborted", "session closed by the bridge");
    await this.session.dispose();
  }
}
