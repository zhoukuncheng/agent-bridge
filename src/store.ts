import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type ThreadKind = "chat" | "oneshot" | "cron";

export interface ThreadRow {
  channel: string;
  thread_ts: string;
  agent: string;
  session_id: string;
  cwd: string;
  model: string | null;
  kind: ThreadKind;
  created_at: number;
  last_active: number;
}

export type ScheduleMode = "fresh" | "continue";

export interface ScheduleRow {
  id: number;
  name: string | null;
  cron: string;
  tz: string | null;
  channel: string;
  agent: string;
  cwd: string;
  model: string | null;
  /** The agent prompt; for an exec schedule, the shell command. */
  prompt: string;
  /** 1: run `prompt` with `sh -c` instead of an agent and post its output. */
  exec: number;
  /** 1: no header or streaming; post only the final answer (cc-connect's silent). */
  silent: number;
  timeout_min: number | null;
  /** Where an imported schedule came from, e.g. cc-connect:3625cb51; keeps imports idempotent. */
  origin: string | null;
  mode: ScheduleMode;
  thread_ts: string | null;
  enabled: number;
  created_by: string;
  created_at: number;
  last_run_at: number | null;
}

export interface NewScheduleRow {
  name?: string | null;
  cron: string;
  tz?: string | null;
  channel: string;
  agent: string;
  cwd: string;
  model?: string | null;
  prompt: string;
  exec?: boolean;
  silent?: boolean;
  timeout_min?: number | null;
  origin?: string | null;
  mode: ScheduleMode;
  enabled?: boolean;
  created_by: string;
}

export interface RunRow {
  id: number;
  schedule_id: number | null;
  channel: string;
  thread_ts: string;
  agent: string;
  started_at: number;
  ended_at: number | null;
  outcome: string | null;
  error: string | null;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS threads (
        channel TEXT NOT NULL, thread_ts TEXT NOT NULL, agent TEXT NOT NULL, session_id TEXT NOT NULL,
        cwd TEXT NOT NULL, model TEXT, kind TEXT NOT NULL, created_at INTEGER NOT NULL, last_active INTEGER NOT NULL,
        PRIMARY KEY (channel, thread_ts));
      CREATE TABLE IF NOT EXISTS schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT, cron TEXT NOT NULL, tz TEXT, channel TEXT NOT NULL, agent TEXT NOT NULL,
        cwd TEXT NOT NULL, model TEXT, prompt TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'fresh', thread_ts TEXT,
        enabled INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, last_run_at INTEGER);
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id INTEGER, channel TEXT NOT NULL, thread_ts TEXT NOT NULL,
        agent TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, outcome TEXT, error TEXT);
    `);
    const columns = new Set((this.db.prepare("PRAGMA table_info(schedules)").all() as { name: string }[]).map((c) => c.name));
    const added: [string, string][] = [
      ["name", "TEXT"],
      ["exec", "INTEGER NOT NULL DEFAULT 0"],
      ["silent", "INTEGER NOT NULL DEFAULT 0"],
      ["timeout_min", "INTEGER"],
      ["origin", "TEXT"],
    ];
    for (const [name, type] of added) if (!columns.has(name)) this.db.exec(`ALTER TABLE schedules ADD COLUMN ${name} ${type}`);
  }

  getThread(channel: string, threadTs: string): ThreadRow | undefined {
    return this.db.prepare("SELECT * FROM threads WHERE channel = ? AND thread_ts = ?").get(channel, threadTs) as ThreadRow | undefined;
  }

  upsertThread(row: Omit<ThreadRow, "created_at" | "last_active">): void {
    const now = Date.now();
    this.db
      .prepare(`INSERT INTO threads (channel, thread_ts, agent, session_id, cwd, model, kind, created_at, last_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (channel, thread_ts) DO UPDATE SET agent = excluded.agent, session_id = excluded.session_id,
          cwd = excluded.cwd, model = excluded.model, last_active = excluded.last_active`)
      .run(row.channel, row.thread_ts, row.agent, row.session_id, row.cwd, row.model, row.kind, now, now);
  }

  touchThread(channel: string, threadTs: string): void {
    this.db.prepare("UPDATE threads SET last_active = ? WHERE channel = ? AND thread_ts = ?").run(Date.now(), channel, threadTs);
  }

  addSchedule(row: NewScheduleRow): ScheduleRow {
    const result = this.db
      .prepare(`INSERT INTO schedules (name, cron, tz, channel, agent, cwd, model, prompt, exec, silent, timeout_min, origin, mode, enabled, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        row.name ?? null,
        row.cron,
        row.tz ?? null,
        row.channel,
        row.agent,
        row.cwd,
        row.model ?? null,
        row.prompt,
        row.exec ? 1 : 0,
        row.silent ? 1 : 0,
        row.timeout_min ?? null,
        row.origin ?? null,
        row.mode,
        row.enabled === false ? 0 : 1,
        row.created_by,
        Date.now(),
      );
    return this.getSchedule(Number(result.lastInsertRowid))!;
  }

  findScheduleByOrigin(origin: string): ScheduleRow | undefined {
    return this.db.prepare("SELECT * FROM schedules WHERE origin = ?").get(origin) as ScheduleRow | undefined;
  }

  getSchedule(id: number): ScheduleRow | undefined {
    return this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as ScheduleRow | undefined;
  }

  listSchedules(): ScheduleRow[] {
    return this.db.prepare("SELECT * FROM schedules ORDER BY id").all() as unknown as ScheduleRow[];
  }

  setScheduleEnabled(id: number, enabled: boolean): boolean {
    return this.db.prepare("UPDATE schedules SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id).changes > 0;
  }

  setScheduleThread(id: number, threadTs: string): void {
    this.db.prepare("UPDATE schedules SET thread_ts = ? WHERE id = ?").run(threadTs, id);
  }

  markScheduleRun(id: number): void {
    this.db.prepare("UPDATE schedules SET last_run_at = ? WHERE id = ?").run(Date.now(), id);
  }

  deleteSchedule(id: number): boolean {
    return this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id).changes > 0;
  }

  startRun(scheduleId: number | null, channel: string, threadTs: string, agent: string): number {
    const result = this.db
      .prepare("INSERT INTO runs (schedule_id, channel, thread_ts, agent, started_at) VALUES (?, ?, ?, ?, ?)")
      .run(scheduleId, channel, threadTs, agent, Date.now());
    return Number(result.lastInsertRowid);
  }

  finishRun(id: number, outcome: string, error?: string): void {
    this.db.prepare("UPDATE runs SET ended_at = ?, outcome = ?, error = ? WHERE id = ?").run(Date.now(), outcome, error ?? null, id);
  }

  lastRuns(scheduleId: number, limit = 1): RunRow[] {
    return this.db.prepare("SELECT * FROM runs WHERE schedule_id = ? ORDER BY id DESC LIMIT ?").all(scheduleId, limit) as unknown as RunRow[];
  }

  close(): void {
    this.db.close();
  }
}
