import { Cron } from "croner";
import type { SessionManager } from "../core/manager.ts";
import { runHeadless, type Runner } from "../core/runner.ts";
import type { SlackApi } from "../slack/api.ts";
import type { NewScheduleRow, ScheduleRow, Store } from "../store.ts";
import { truncate } from "../agents/types.ts";
import { runShell } from "./exec.ts";

export interface SchedulerOptions {
  runTimeoutMinutes: number;
  teamId?: string;
  /** What to do about a firing missed while the bridge was down. */
  catchUp?: "run" | "notify" | "off";
  catchUpHours?: number;
}

export type NewSchedule = Omit<NewScheduleRow, "created_by"> & { createdBy: string };

export const scheduleLabel = (row: ScheduleRow) => row.name || truncate(row.prompt.replace(/\s+/g, " "), 60);

/**
 * In-process cron. A firing runs one of three ways:
 * - agent, default: a header message, then the answer streams into its thread
 *   (`fresh`: a new thread every time; `continue`: one thread, resumed session);
 * - agent, silent: nothing while it works, then only the final answer, as a new message
 *   whose thread continues the session (cc-connect's `silent`);
 * - exec: `sh -c` the command and post its output (cc-connect's `--exec`).
 * A firing is skipped while the previous one is still running. Firings missed while the
 * bridge was down are not replayed.
 */
export class Scheduler {
  private jobs = new Map<number, Cron>();
  private running = new Set<number>();
  private readonly store: Store;
  private readonly runner: Runner;
  private readonly manager: SessionManager;
  private readonly api: SlackApi;
  private readonly options: SchedulerOptions;

  constructor(store: Store, runner: Runner, manager: SessionManager, api: SlackApi, options: SchedulerOptions) {
    this.store = store;
    this.runner = runner;
    this.manager = manager;
    this.api = api;
    this.options = options;
  }

  /** Arms enabled schedules and returns the catch-up of missed firings (already started). */
  start(now = new Date()): Promise<void> {
    const missed: { row: ScheduleRow; at: Date }[] = [];
    const policy = this.options.catchUp ?? "off";
    const windowMs = (this.options.catchUpHours ?? 12) * 3_600_000;
    for (const row of this.store.listSchedules()) {
      if (!row.enabled) continue;
      this.arm(row);
      if (policy === "off") continue;
      const probe = new Cron(row.cron, { paused: true, ...(row.tz ? { timezone: row.tz } : {}) });
      const previous = probe.previousRuns(1, now)[0];
      probe.stop();
      const baseline = row.last_run_at ?? row.created_at;
      if (previous && previous.getTime() > baseline && now.getTime() - previous.getTime() <= windowMs) missed.push({ row, at: previous });
    }
    return this.catchUp(missed, policy);
  }

  /** Runs missed firings one at a time, telling each schedule's owner first. */
  private async catchUp(missed: { row: ScheduleRow; at: Date }[], policy: "run" | "notify" | "off"): Promise<void> {
    for (const { row, at } of missed) {
      const when = at.toISOString().replace("T", " ").slice(0, 16) + " UTC";
      const action = policy === "run" ? "running it now" : `run it with \`!cron run ${row.id}\``;
      await this.notifyOwner(row, `⏰ schedule #${row.id} *${scheduleLabel(row)}* missed its ${when} run while the bridge was down; ${action}.`);
      if (policy === "run") await this.fire(row.id).catch((err) => this.reportFailure(row.id, err));
    }
  }

  private async notifyOwner(row: ScheduleRow, text: string): Promise<void> {
    try {
      const dm = await this.api.openDm(row.created_by);
      await this.api.postMessage({ channel: dm, text });
    } catch (err) {
      console.error(`schedule ${row.id}: could not notify the owner`, err);
    }
  }

  private async reportFailure(id: number, err: unknown): Promise<void> {
    console.error(`schedule ${id} failed`, err);
    const row = this.store.getSchedule(id);
    if (row) await this.notifyOwner(row, `❌ schedule #${id} *${scheduleLabel(row)}* failed to run: ${(err as Error)?.message ?? String(err)}`);
  }

  stop(): void {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }

  /** Throws when the expression or timezone is invalid. */
  static validate(expr: string, tz?: string | null): Date | null {
    const probe = new Cron(expr, { paused: true, ...(tz ? { timezone: tz } : {}) });
    const next = probe.nextRun();
    probe.stop();
    return next;
  }

  add(spec: NewSchedule): ScheduleRow {
    Scheduler.validate(spec.cron, spec.tz);
    const { createdBy, ...rest } = spec;
    const row = this.store.addSchedule({ ...rest, created_by: createdBy });
    if (row.enabled) this.arm(row);
    return row;
  }

  remove(id: number): boolean {
    this.disarm(id);
    return this.store.deleteSchedule(id);
  }

  setEnabled(id: number, enabled: boolean): boolean {
    if (!this.store.setScheduleEnabled(id, enabled)) return false;
    if (enabled) this.arm(this.store.getSchedule(id)!);
    else this.disarm(id);
    return true;
  }

  nextRun(id: number): Date | null {
    return this.jobs.get(id)?.nextRun() ?? null;
  }

  isRunning(id: number): boolean {
    return this.running.has(id);
  }

  private arm(row: ScheduleRow): void {
    this.disarm(row.id);
    const job = new Cron(row.cron, { ...(row.tz ? { timezone: row.tz } : {}) }, () => {
      void this.fire(row.id).catch((err) => this.reportFailure(row.id, err));
    });
    this.jobs.set(row.id, job);
  }

  private disarm(id: number): void {
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
  }

  /** Runs a schedule now. Returns false when it was skipped because a run is in progress. */
  async fire(id: number): Promise<boolean> {
    const row = this.store.getSchedule(id);
    if (!row) return false;
    if (this.running.has(id)) {
      console.warn(`schedule ${id}: previous run still in progress, skipping`);
      return false;
    }
    this.running.add(id);
    try {
      this.store.markScheduleRun(id);
      const timeout = row.timeout_min ?? this.options.runTimeoutMinutes;
      if (row.exec) await this.fireExec(row, timeout);
      else if (row.silent) await this.fireSilent(row, timeout);
      else await this.fireStreamed(row, timeout);
      return true;
    } finally {
      this.running.delete(id);
    }
  }

  private setRunThread(runId: number, ts: string): void {
    this.store.db.prepare("UPDATE runs SET thread_ts = ? WHERE id = ?").run(ts, runId);
  }

  private async fireExec(row: ScheduleRow, timeout: number): Promise<void> {
    const runId = this.store.startRun(row.id, row.channel, "", "exec");
    const result = await runShell(row.prompt, row.cwd, timeout);
    const output = truncate(result.output.trim(), 3500);
    const head = `*${scheduleLabel(row)}* · \`${truncate(row.prompt, 60)}\``;
    let text: string;
    if (result.timedOut) text = `⏰ ⚠️ ${head} timed out after ${timeout} min${output ? `\n\n${output}` : ""}`;
    else if (result.code === 0) text = `⏰ ✅ ${head}\n\n${output || "(no output)"}`;
    else text = `⏰ ❌ ${head}${output ? `\n\n${output}` : ""}\n\nerror: exit code ${result.code}`;
    const { ts } = await this.api.postMessage({ channel: row.channel, text });
    this.setRunThread(runId, ts);
    const outcome = result.timedOut ? "aborted" : result.code === 0 ? "completed" : "failed";
    this.store.finishRun(runId, outcome, outcome === "completed" ? undefined : `exit ${result.code}`);
  }

  private async fireSilent(row: ScheduleRow, timeout: number): Promise<void> {
    const spec = { agent: row.agent, cwd: row.cwd, model: row.model ?? undefined, kind: "cron" as const };
    const runId = this.store.startRun(row.id, row.channel, "", row.agent);
    const result = await runHeadless(this.manager, spec, row.prompt, timeout);
    let text = result.answer === "NO_REPLY" ? "" : result.answer;
    if (result.outcome !== "completed") {
      text = `⏰ ❌ *${scheduleLabel(row)}* ${result.outcome}${result.error ? `: ${result.error}` : ""}${text ? `\n\n${text}` : ""}`;
    }
    if (text) {
      const { ts } = await this.api.postMessage({ channel: row.channel, text: truncate(text, 39_000) });
      this.setRunThread(runId, ts);
      // Replying in the answer's thread continues the run's session.
      if (result.sessionId) {
        this.store.upsertThread({ channel: row.channel, thread_ts: ts, agent: row.agent, session_id: result.sessionId, cwd: row.cwd, model: row.model, kind: "cron" });
      }
    }
    this.store.finishRun(runId, result.outcome, result.error);
  }

  private async fireStreamed(row: ScheduleRow, timeout: number): Promise<void> {
    const header = `⏰ *${scheduleLabel(row)}* · #${row.id} · ${row.agent} · \`${row.cron}\`${row.tz ? ` (${row.tz})` : ""}`;
    let threadTs: string;
    if (row.mode === "continue" && row.thread_ts) {
      threadTs = row.thread_ts;
      await this.api.postMessage({ channel: row.channel, thread_ts: threadTs, text: `⏰ run at ${new Date().toISOString()}` });
    } else {
      threadTs = (await this.api.postMessage({ channel: row.channel, text: header })).ts;
      if (row.mode === "continue") this.store.setScheduleThread(row.id, threadTs);
    }
    const isDm = row.channel.startsWith("D");
    await this.runner.runOnce({
      target: { channel: row.channel, threadTs, ...(isDm ? {} : { recipientUserId: row.created_by, teamId: this.options.teamId }) },
      spec: { agent: row.agent, cwd: row.cwd, model: row.model ?? undefined, kind: "cron" },
      prompt: row.prompt,
      timeoutMinutes: timeout,
      scheduleId: row.id,
    });
  }
}
