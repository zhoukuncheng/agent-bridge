import { parseCommand } from "../core/commands.ts";
import { expandHome, type Config } from "../config.ts";
import { ScheduleTimer, scheduleLabel } from "../sched/scheduler.ts";
import type { ScheduleRow, Store } from "../store.ts";
import type { Target } from "./api.ts";
import { cronSelection, cronUsage, describeCronSelection } from "./preferences.ts";
import { defaults } from "./providers.ts";

export const cronHelp = [
  '/cron add "<expr>" [--name N] [--tz TZ] [--cwd DIR] [--timeout MIN] [--mode fresh|continue] [--silent] [--exec] <prompt or shell command>',
  "/cron list · /cron run <id> · /cron pause <id> · /cron resume <id> · /cron rm <id>",
  `${cronUsage} — provider, model and reasoning for every agent schedule`,
].join("\n");

export interface CronContext {
  config: Config;
  store: Store;
  scheduler: Pick<ScheduleTimer, "add" | "remove" | "setEnabled" | "fire" | "nextRun" | "isRunning">;
  /** Where the command came from; new schedules post back here, including the forum topic. */
  target: Target;
  send: (text: string) => Promise<unknown>;
}

const kind = (row: ScheduleRow) => (row.exec ? "exec" : row.silent ? "silent" : row.mode);

export function cronList(ctx: Pick<CronContext, "config" | "store" | "scheduler">): string {
  const rows = ctx.store.listSchedules().map((row) => {
    const state = !row.enabled ? "paused" : ctx.scheduler.isRunning(row.id) ? "running" : `next ${ctx.scheduler.nextRun(row.id)?.toISOString() ?? "never"}`;
    return `#${row.id} ${scheduleLabel(row)} · ${row.cron}${row.tz ? ` (${row.tz})` : ""} · ${kind(row)} · ${state}`;
  });
  return [describeCronSelection(cronSelection(ctx.store, ctx.config.telegram!)), ...(rows.length ? rows : ["No schedules."]), "", cronHelp].join("\n");
}

/** Handles every /cron subcommand except `set`, which validates against the live model catalog. */
export async function cronCommand(text: string, ctx: CronContext): Promise<string> {
  // Phone keyboards often turn straight quotes into curly ones.
  const command = parseCommand("!cron " + text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"));
  switch (command.kind) {
    case "cron_list":
      return cronList(ctx);
    case "cron_add": {
      const { options } = command;
      if (options.agent || options.model || options.channel) {
        return `--agent, --model and --channel are not available on Telegram: schedules post to the chat where they were added and use the shared ${cronUsage} selection.`;
      }
      let row: ScheduleRow;
      try {
        row = ctx.scheduler.add({
          cron: options.expr,
          tz: options.tz,
          channel: ctx.target.chat_id,
          agent: defaults(ctx.config.telegram!).provider,
          cwd: expandHome(options.cwd ?? ctx.config.defaultCwd),
          prompt: command.prompt,
          mode: options.mode ?? "fresh",
          name: options.name,
          silent: options.silent,
          exec: options.exec,
          timeout_min: options.timeoutMinutes,
          createdBy: ctx.config.ownerUserId,
        });
      } catch (err) {
        return `Invalid schedule: ${(err as Error).message}`;
      }
      // Telegram schedules never use thread_ts for Slack-style continue threads, so it carries the forum topic.
      if (ctx.target.message_thread_id) ctx.store.setScheduleThread(row.id, String(ctx.target.message_thread_id));
      const next = ctx.scheduler.nextRun(row.id);
      return `Added schedule #${row.id} ${scheduleLabel(row)} · ${row.cron}${row.tz ? ` (${row.tz})` : ""} · ${kind(row)}\nNext run: ${next ? next.toISOString() : "never"}`;
    }
    case "cron_rm":
      return ctx.scheduler.remove(command.id) ? `Removed schedule #${command.id}.` : `No schedule #${command.id}.`;
    case "cron_pause":
    case "cron_resume": {
      const enable = command.kind === "cron_resume";
      return ctx.scheduler.setEnabled(command.id, enable) ? `Schedule #${command.id} ${enable ? "resumed" : "paused"}.` : `No schedule #${command.id}.`;
    }
    case "cron_run": {
      if (!ctx.store.getSchedule(command.id)) return `No schedule #${command.id}.`;
      void ctx.scheduler.fire(command.id).then(
        (ran) => (ran ? undefined : ctx.send(`Schedule #${command.id} is still running; skipped.`)),
        (err) => ctx.send(`Schedule #${command.id} failed: ${(err as Error).message}`),
      ).catch(() => {});
      return `Running schedule #${command.id} now.`;
    }
    case "error":
      return `${command.message.replace(/!cron/g, "/cron")}\n\n${cronHelp}`;
    default:
      return cronHelp;
  }
}
