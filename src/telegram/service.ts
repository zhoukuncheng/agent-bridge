import { fileURLToPath } from "node:url";
import { runCodex } from "../agents/codex.ts";
import { expandHome, type Config } from "../config.ts";
import { runShell } from "../sched/exec.ts";
import { ScheduleTimer } from "../sched/scheduler.ts";
import { Store, type ScheduleRow } from "../store.ts";
import { type Format, Telegram, type Target } from "./api.ts";

function deliveryEnv(target: Target) {
  const bin = fileURLToPath(new URL("../../deploy/telegram-bin", import.meta.url));
  return {
    PATH: bin + ":" + process.env.PATH,
    BRIDGE_CHAT_ID: target.chat_id,
    BRIDGE_TOPIC: String(target.message_thread_id ?? ""),
  };
}

export class TelegramService extends ScheduleTimer {
  private config: Config;
  private bot: Pick<Telegram, "send">;
  constructor(config: Config, store: Store, bot: Pick<Telegram, "send">) {
    super(store, {
      openDm: async id => id,
      postMessage: async ({ channel, text }) => ({ ts: String((await bot.send({ chat_id: channel }, text)).message_id) }),
    }, { runTimeoutMinutes: config.runTimeoutMinutes, catchUp: config.cronCatchUp, catchUpHours: config.cronCatchUpHours });
    this.config = config;
    this.bot = bot;
  }

  async turn(target: Target, thread: string, prompt: string, opts: {
    cwd?: string; timeout: number; resume: boolean; signal?: AbortSignal; schedule?: number; format?: Format;
  }) {
    const cfg = this.config.telegram!;
    const cwd = expandHome(opts.cwd ?? this.config.defaultCwd);
    const id = this.store.startRun(opts.schedule ?? null, target.chat_id, thread, "codex");
    const signals = opts.signal ? [opts.signal] : [];
    if (opts.timeout > 0) signals.push(AbortSignal.timeout(opts.timeout * 60_000));
    try {
      const result = await runCodex(prompt, { cwd, model: cfg.model, effort: cfg.effort, fullAccess: cfg.fullAccess,
        resume: opts.resume ? this.store.getThread(target.chat_id, thread)?.session_id : undefined,
        signal: AbortSignal.any(signals), env: deliveryEnv(target) });
      this.store.upsertThread({ channel: target.chat_id, thread_ts: thread, agent: "codex", session_id: result.sessionId, cwd, model: cfg.model, kind: opts.schedule ? "cron" : "chat" });
      await this.bot.send(target, result.answer, opts.format);
      this.store.finishRun(id, "completed");
    } catch (err) {
      this.store.finishRun(id, "failed", (err as Error).message);
      throw err;
    }
  }

  protected async execute(row: ScheduleRow, timeout: number) {
    const target = { chat_id: row.channel };
    if (!row.exec) {
      if (!row.silent) await this.bot.send(target, `⏰ ${row.name ?? row.id}`);
      return this.turn(target, "cron:" + row.id, row.prompt, { cwd: row.cwd, timeout, resume: row.mode === "continue", schedule: row.id });
    }
    const run = this.store.startRun(row.id, row.channel, "", "exec");
    try {
      const result = await runShell(row.prompt, row.cwd, timeout, deliveryEnv(target));
      if (result.timedOut || result.code !== 0) throw new Error(`exit ${result.code}: ${result.output.slice(-2000)}`);
      await this.bot.send(target, result.output.trim() || "完成");
      this.store.finishRun(run, "completed");
    } catch (err) {
      this.store.finishRun(run, "failed", (err as Error).message);
      throw err;
    }
  }
}
