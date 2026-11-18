import type { AgentEvent, AgentSession, TurnOutcome } from "../agents/types.ts";
import type { SlackApi } from "../slack/api.ts";
import { formatDuration, TurnRenderer, type DisplayMode, type RenderOptions, type ThreadTarget } from "../slack/render.ts";

export interface TurnResult {
  outcome: TurnOutcome;
  error?: string;
}

export interface StallOptions {
  /** Post a warning when a running turn has produced nothing for this long. 0 disables. */
  warnMinutes: number;
  /** Abort a turn that has produced nothing for this long. 0 never aborts. */
  abortMinutes: number;
  checkMs?: number;
}

/** Connects one agent session to one Slack thread: each turn gets its own renderer. */
export class SessionBinding {
  private renderer: TurnRenderer | undefined;
  private waiters: ((result: TurnResult) => void)[] = [];
  private readonly unsubscribe: () => void;
  lastActive = Date.now();
  /** Last agent event of any kind; drives the stall watchdog. */
  private lastEventAt = Date.now();
  private stallWarned = false;
  private stallAborted = false;
  private watchdog: NodeJS.Timeout | undefined;
  exited = false;
  onExit: () => void = () => {};

  readonly session: AgentSession;
  private readonly api: SlackApi;
  readonly target: ThreadTarget;
  private renderOptions: Partial<RenderOptions>;
  private readonly stall: StallOptions;

  constructor(session: AgentSession, api: SlackApi, target: ThreadTarget, renderOptions: Partial<RenderOptions> = {}, stall: StallOptions = { warnMinutes: 0, abortMinutes: 0 }) {
    this.session = session;
    this.api = api;
    this.target = target;
    this.renderOptions = renderOptions;
    this.stall = stall;
    this.unsubscribe = session.onEvent((event) => this.handle(event));
    if (stall.warnMinutes > 0 || stall.abortMinutes > 0) {
      this.watchdog = setInterval(() => void this.checkStall(), stall.checkMs ?? 30_000);
      this.watchdog.unref();
    }
  }

  /** Applies to the next turn. */
  setDisplay(display: DisplayMode): void {
    this.renderOptions = { ...this.renderOptions, display };
  }

  private current(): TurnRenderer {
    this.renderer ??= new TurnRenderer(this.api, this.target, this.renderOptions);
    return this.renderer;
  }

  private handle(event: AgentEvent): void {
    this.lastActive = Date.now();
    this.lastEventAt = Date.now();
    this.stallWarned = false;
    switch (event.type) {
      case "turn_start":
        this.stallAborted = false;
        this.current();
        break;
      case "turn_end":
        this.endTurn({ outcome: event.outcome, error: event.error ?? (this.stallAborted && event.outcome === "aborted" ? "stopped by the stall watchdog" : undefined) });
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

  private async checkStall(): Promise<void> {
    if (!this.session.busy() || this.stallAborted) return;
    const idle = Date.now() - this.lastEventAt;
    const { warnMinutes, abortMinutes } = this.stall;
    try {
      if (abortMinutes > 0 && idle >= abortMinutes * 60_000) {
        this.stallAborted = true;
        await this.api.postMessage({ channel: this.target.channel, thread_ts: this.target.threadTs, text: `⏹️ no activity for ${formatDuration(idle)}; stopping the turn` });
        await this.session.abort();
      } else if (warnMinutes > 0 && idle >= warnMinutes * 60_000 && !this.stallWarned) {
        this.stallWarned = true;
        await this.api.postMessage({
          channel: this.target.channel,
          thread_ts: this.target.threadTs,
          text: `⚠️ no activity for ${formatDuration(idle)} — the agent may be stuck. \`!stop\` to interrupt, or keep waiting.`,
        });
      }
    } catch (err) {
      console.warn("stall check failed", err);
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
    this.lastEventAt = Date.now();
    return this.session.send(text);
  }

  async dispose(): Promise<void> {
    if (this.watchdog) clearInterval(this.watchdog);
    this.unsubscribe();
    if (this.renderer) await this.renderer.finish("aborted", "session closed by the bridge");
    await this.session.dispose();
  }
}
