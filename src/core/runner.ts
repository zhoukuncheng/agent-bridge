import type { SlackApi } from "../slack/api.ts";
import type { ThreadTarget } from "../slack/render.ts";
import type { Store } from "../store.ts";
import type { TurnResult } from "./binding.ts";
import type { SessionManager, SessionSpec } from "./manager.ts";

export interface HeadlessResult extends TurnResult {
  /** Text the agent wrote after its last tool call: its final answer. */
  answer: string;
  sessionId?: string;
}

export interface OneShotRequest {
  target: ThreadTarget;
  spec: SessionSpec;
  prompt: string;
  timeoutMinutes: number;
  scheduleId?: number;
}

/**
 * Runs a prompt with no Slack output while it works and returns the final answer.
 * Used by silent schedules, which post only the result.
 */
export async function runHeadless(manager: SessionManager, spec: SessionSpec, prompt: string, timeoutMinutes: number): Promise<HeadlessResult> {
  let session;
  try {
    session = await manager.openDetached(spec);
  } catch (err) {
    return { outcome: "failed", error: (err as Error).message, answer: "" };
  }
  let answer = "";
  let timer: NodeJS.Timeout | undefined;
  try {
    const ended = new Promise<TurnResult>((resolve) => {
      session.onEvent((event) => {
        if (event.type === "tool_start") answer = "";
        else if (event.type === "text") answer += event.text;
        else if (event.type === "turn_end") resolve({ outcome: event.outcome, error: event.error });
        else if (event.type === "exited") resolve({ outcome: "failed", error: `agent process exited (${event.code})` });
      });
    });
    let timedOut = false;
    const gaveUp = new Promise<TurnResult>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        void session.abort().catch(() => {});
        setTimeout(() => resolve({ outcome: "aborted" }), 15_000).unref();
      }, timeoutMinutes * 60_000);
      timer.unref();
    });
    await session.send(prompt);
    const turn = await Promise.race([ended, gaveUp]);
    const result: HeadlessResult = timedOut
      ? { outcome: "aborted", error: `timed out after ${timeoutMinutes} min`, answer: answer.trim(), sessionId: session.id }
      : { ...turn, answer: answer.trim(), sessionId: session.id };
    return result;
  } catch (err) {
    return { outcome: "failed", error: (err as Error).message, answer: answer.trim(), sessionId: session.id };
  } finally {
    clearTimeout(timer);
    await session.dispose().catch(() => {});
  }
}

/** Runs a single prompt to completion in a thread, then frees the process (replies resume it). */
export class Runner {
  private readonly manager: SessionManager;
  private readonly store: Store;
  private readonly api: SlackApi;

  constructor(manager: SessionManager, store: Store, api: SlackApi) {
    this.manager = manager;
    this.store = store;
    this.api = api;
  }

  async runOnce(req: OneShotRequest): Promise<TurnResult & { sessionId?: string }> {
    const runId = this.store.startRun(req.scheduleId ?? null, req.target.channel, req.target.threadTs, req.spec.agent);
    let result: TurnResult & { sessionId?: string };
    try {
      const { binding } = await this.manager.getOrOpen(req.target, req.spec);
      if (binding.session.busy()) {
        result = { outcome: "failed", error: "the thread's session is still running the previous turn; skipped" };
        await this.api.postMessage({ channel: req.target.channel, thread_ts: req.target.threadTs, text: `⏭️ ${result.error}` });
      } else {
        const ended = binding.nextTurnEnd();
        let timedOut = false;
        let timer: NodeJS.Timeout | undefined;
        const gaveUp = new Promise<TurnResult>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            void binding.session.abort().catch(() => {});
            // Give the runtime time to report its own aborted turn before giving up on it.
            setTimeout(() => resolve({ outcome: "aborted" }), 15_000).unref();
          }, req.timeoutMinutes * 60_000);
          timer.unref();
        });
        await binding.send(req.prompt);
        const turn = await Promise.race([ended, gaveUp]);
        clearTimeout(timer);
        result = timedOut
          ? { outcome: "aborted", error: `timed out after ${req.timeoutMinutes} min`, sessionId: binding.session.id }
          : { ...turn, sessionId: binding.session.id };
      }
    } catch (err) {
      result = { outcome: "failed", error: (err as Error).message };
      await this.api
        .postMessage({ channel: req.target.channel, thread_ts: req.target.threadTs, text: `❌ ${(err as Error).message}` })
        .catch(() => {});
    } finally {
      await this.manager.release(req.target.channel, req.target.threadTs);
    }
    this.store.finishRun(runId, result.outcome, result.error);
    return result;
  }
}
