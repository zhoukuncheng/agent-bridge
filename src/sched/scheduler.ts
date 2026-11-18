import { Cron } from "croner";
import type { Runner } from "../core/runner.ts";
import type { SlackApi } from "../slack/api.ts";
import type { ScheduleMode, ScheduleRow, Store } from "../store.ts";
import { truncate } from "../agents/types.ts";

export interface NewSchedule {
  cron: string;
  tz?: string;
  channel: string;
  agent: string;
  cwd: string;
  model?: string;
  prompt: string;
  mode: ScheduleMode;
  createdBy: string;
}

/**
 * In-process cron. Each firing runs the prompt once: `fresh` schedules open a new
 * top-level thread every time; `continue` schedules keep one thread and resume its
 * session. A firing is skipped while the previous one is still running. Firings missed
 * while the bridge was down are not replayed.
 */
export class Scheduler {
  private jobs = new Map<number, Cron>();
  private running = new Set<number>();

  private readonly store: Store;
  private readonly runner: Runner;
  private readonly api: SlackApi;
  private readonly options: { runTimeoutMinutes: number; teamId?: string };

  constructor(store: Store, runner: Runner, api: SlackApi, options: { runTimeoutMinutes: number; teamId?: string }) {
    this.store = store;
    this.runner = runner;
    this.api = api;
    this.options = options;
  }

  start(): void {
    for (const row of this.store.listSchedules()) if (row.enabled) this.arm(row);
  }

  stop(): void {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }

  /** Throws when the expression or timezone is invalid. */
  static validate(expr: string, tz?: string): Date | null {
    const probe = new Cron(expr, { paused: true, ...(tz ? { timezone: tz } : {}) });
    const next = probe.nextRun();
    probe.stop();
    return next;
  }

  add(spec: NewSchedule): ScheduleRow {
    Scheduler.validate(spec.cron, spec.tz);
    const row = this.store.addSchedule({
      cron: spec.cron,
      tz: spec.tz ?? null,
      channel: spec.channel,
      agent: spec.agent,
      cwd: spec.cwd,
      model: spec.model ?? null,
      prompt: spec.prompt,
      mode: spec.mode,
      created_by: spec.createdBy,
    });
    this.arm(row);
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
      void this.fire(row.id).catch((err) => console.error(`schedule ${row.id} failed`, err));
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
      const header = `⏰ *Schedule #${row.id}* · ${row.agent} · \`${row.cron}\`${row.tz ? ` (${row.tz})` : ""}\n> ${truncate(row.prompt.replace(/\n/g, " "), 300)}`;
      let threadTs: string;
      if (row.mode === "continue" && row.thread_ts) {
        threadTs = row.thread_ts;
        await this.api.postMessage({ channel: row.channel, thread_ts: threadTs, text: `⏰ run at ${new Date().toISOString()}` });
      } else {
        threadTs = (await this.api.postMessage({ channel: row.channel, text: header })).ts;
        if (row.mode === "continue") this.store.setScheduleThread(id, threadTs);
      }
      const isDm = row.channel.startsWith("D");
      await this.runner.runOnce({
        target: {
          channel: row.channel,
          threadTs,
          ...(isDm ? {} : { recipientUserId: row.created_by, teamId: this.options.teamId }),
        },
        spec: { agent: row.agent, cwd: row.cwd, model: row.model ?? undefined, kind: "cron" },
        prompt: row.prompt,
        timeoutMinutes: this.options.runTimeoutMinutes,
        scheduleId: id,
      });
      return true;
    } finally {
      this.running.delete(id);
    }
  }
}
