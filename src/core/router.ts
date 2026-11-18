import { statSync } from "node:fs";
import { truncate } from "../agents/types.ts";
import { expandHome, type Config } from "../config.ts";
import type { SlackApi } from "../slack/api.ts";
import type { ThreadTarget } from "../slack/render.ts";
import { Scheduler } from "../sched/scheduler.ts";
import type { Store } from "../store.ts";
import { decodeSlackText, helpText, parseCommand, stripMention, type RunOptions } from "./commands.ts";
import type { SessionManager, SessionSpec } from "./manager.ts";
import type { Runner } from "./runner.ts";

const channelRef = (id: string) => (id.startsWith("D") ? "DM" : `<#${id}>`);

export interface InboundMessage {
  channel: string;
  /** "im" for DMs; "channel", "group" or "mpim" otherwise. */
  channelType: string;
  user: string;
  text: string;
  ts: string;
  threadTs?: string;
  teamId?: string;
}

export interface RouterDeps {
  config: Config;
  store: Store;
  api: SlackApi;
  manager: SessionManager;
  runner: Runner;
  scheduler: Scheduler;
  botUserId: string;
  teamId?: string;
}

/** Decides what an incoming Slack message means and dispatches it. */
export class Router {
  private seen = new Map<string, number>();
  /** Background work (one-shot runs) started by handle(); tests await it. */
  readonly background = new Set<Promise<unknown>>();

  private readonly deps: RouterDeps;

  constructor(deps: RouterDeps) {
    this.deps = deps;
  }

  private dedupe(msg: InboundMessage): boolean {
    const key = `${msg.channel}:${msg.ts}`;
    const now = Date.now();
    if (this.seen.has(key)) return false;
    this.seen.set(key, now);
    if (this.seen.size > 2000) {
      for (const [k, at] of this.seen) if (now - at > 10 * 60_000) this.seen.delete(k);
    }
    return true;
  }

  private reply(channel: string, threadTs: string, text: string): Promise<unknown> {
    return this.deps.api.postMessage({ channel, thread_ts: threadTs, text }).catch((err) => console.error("reply failed", err));
  }

  private track(work: Promise<unknown>): void {
    this.background.add(work);
    void work.finally(() => this.background.delete(work));
  }

  async handle(msg: InboundMessage): Promise<void> {
    const { config, manager, botUserId } = this.deps;
    if (!config.allowUsers.includes(msg.user)) return;
    const isDm = msg.channelType === "im";
    if (!isDm && config.allowChannels.length && !config.allowChannels.includes(msg.channel)) return;

    const inThread = Boolean(msg.threadTs && msg.threadTs !== msg.ts);
    const mentioned = msg.text.includes(`<@${botUserId}`);
    const owned = inThread && manager.owns(msg.channel, msg.threadTs!);
    if (!isDm && !mentioned && !owned) return;
    if (!this.dedupe(msg)) return;

    const anchor = inThread ? msg.threadTs! : msg.ts;
    const target: ThreadTarget = {
      channel: msg.channel,
      threadTs: anchor,
      ...(isDm ? {} : { recipientUserId: msg.user, teamId: msg.teamId ?? this.deps.teamId }),
    };
    const text = decodeSlackText(stripMention(msg.text, botUserId));
    const command = parseCommand(text);

    try {
      switch (command.kind) {
        case "help":
          await this.reply(msg.channel, anchor, helpText);
          return;
        case "error":
          await this.reply(msg.channel, anchor, `⚠️ ${command.message}`);
          return;
        case "stop":
          return await this.stop(msg, anchor);
        case "status":
          return await this.status(msg, anchor);
        case "release": {
          const released = await manager.release(msg.channel, anchor);
          await this.reply(msg.channel, anchor, released ? "💤 released; the next reply resumes the session" : "no live session in this thread");
          return;
        }
        case "chat":
          if (!command.prompt) {
            await this.reply(msg.channel, anchor, helpText);
            return;
          }
          return await this.chat(target, command.options, command.prompt, owned);
        case "run": {
          if (owned) {
            await this.reply(msg.channel, anchor, "⚠️ this thread already has a session; send `!run` as a new top-level message");
            return;
          }
          const spec = this.spec(msg.channel, command.options, "oneshot");
          await this.reply(msg.channel, anchor, `▶️ one-shot · *${spec.agent}* · \`${spec.cwd}\``);
          this.track(
            this.deps.runner.runOnce({ target, spec, prompt: command.prompt, timeoutMinutes: command.options.timeoutMinutes ?? config.runTimeoutMinutes }),
          );
          return;
        }
        case "cron_add":
          return await this.cronAdd(msg, anchor, command);
        case "cron_list":
          await this.reply(msg.channel, anchor, this.cronList());
          return;
        case "cron_rm":
          await this.reply(msg.channel, anchor, this.deps.scheduler.remove(command.id) ? `🗑️ schedule #${command.id} removed` : `no schedule #${command.id}`);
          return;
        case "cron_pause":
        case "cron_resume": {
          const enable = command.kind === "cron_resume";
          const ok = this.deps.scheduler.setEnabled(command.id, enable);
          await this.reply(msg.channel, anchor, ok ? `schedule #${command.id} ${enable ? "resumed" : "paused"}` : `no schedule #${command.id}`);
          return;
        }
        case "cron_run": {
          if (!this.deps.store.getSchedule(command.id)) {
            await this.reply(msg.channel, anchor, `no schedule #${command.id}`);
            return;
          }
          await this.reply(msg.channel, anchor, `▶️ running schedule #${command.id} now`);
          this.track(this.deps.scheduler.fire(command.id));
          return;
        }
      }
    } catch (err) {
      console.error("handle failed", err);
      await this.reply(msg.channel, anchor, `⚠️ ${(err as Error).message}`);
    }
  }

  private spec(channel: string, options: RunOptions, kind: SessionSpec["kind"]): SessionSpec {
    const { config } = this.deps;
    const agent = options.agent ?? config.defaultAgent;
    if (!config.agents[agent]) throw new Error(`unknown agent "${agent}" (configured: ${Object.keys(config.agents).join(", ")})`);
    const cwd = expandHome(options.cwd ?? config.channelCwd[channel] ?? config.defaultCwd);
    let isDir = false;
    try {
      isDir = statSync(cwd).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw new Error(`working directory does not exist: ${cwd}`);
    return { agent, cwd, model: options.model, kind };
  }

  private async chat(target: ThreadTarget, options: RunOptions, prompt: string, owned: boolean): Promise<void> {
    const { manager } = this.deps;
    const spec = this.spec(target.channel, options, "chat");
    const stored = owned ? this.deps.store.getThread(target.channel, target.threadTs) : undefined;
    if (stored && options.agent && options.agent !== stored.agent) {
      await this.reply(target.channel, target.threadTs, `⚠️ this thread runs *${stored.agent}*; start a new top-level message to use ${options.agent}`);
      return;
    }
    const { binding, created } = await manager.getOrOpen(target, spec);
    if (created) {
      await this.reply(
        target.channel,
        target.threadTs,
        `🤖 *${spec.agent}*${spec.model ? ` (${spec.model})` : ""} · \`${spec.cwd}\` · session \`${binding.session.id.slice(0, 8)}\` — reply here to continue, \`!stop\` to interrupt`,
      );
    }
    this.deps.store.touchThread(target.channel, target.threadTs);
    const landed = await binding.send(prompt);
    if (landed === "steered") await this.reply(target.channel, target.threadTs, "↪️ added to the running turn");
    if (landed === "queued") await this.reply(target.channel, target.threadTs, "⏳ queued; it runs after the current turn");
  }

  private async stop(msg: InboundMessage, anchor: string): Promise<void> {
    const binding = this.deps.manager.get(msg.channel, anchor);
    if (!binding || !binding.session.busy()) {
      await this.reply(msg.channel, anchor, "nothing is running in this thread");
      return;
    }
    await binding.session.abort();
    await this.reply(msg.channel, anchor, "⏹️ stopping");
  }

  private async status(msg: InboundMessage, anchor: string): Promise<void> {
    const stored = this.deps.store.getThread(msg.channel, anchor);
    const live = this.deps.manager.get(msg.channel, anchor);
    const lines = [
      stored
        ? `*${stored.agent}* · \`${stored.cwd}\` · session \`${stored.session_id}\` · ${live ? (live.session.busy() ? "running" : "idle (live)") : "released"}`
        : "no session in this thread",
      `live sessions: ${this.deps.manager.liveCount()}/${this.deps.config.maxLiveSessions}`,
    ];
    await this.reply(msg.channel, anchor, lines.join("\n"));
  }

  private async resolveChannel(value: string | undefined, msg: InboundMessage): Promise<string> {
    if (!value || value === "here") return msg.channel;
    if (value === "dm") return this.deps.api.openDm(msg.user);
    const ref = value.match(/^<#([CG][A-Z0-9]+)>$/)?.[1] ?? value.match(/^([CGD][A-Z0-9]{6,})$/)?.[1];
    if (!ref) throw new Error(`--channel must be here, dm, a #channel mention or a channel id (got ${value})`);
    return ref;
  }

  private async cronAdd(msg: InboundMessage, anchor: string, command: Extract<ReturnType<typeof parseCommand>, { kind: "cron_add" }>): Promise<void> {
    const channel = await this.resolveChannel(command.options.channel, msg);
    const spec = this.spec(channel, command.options, "cron");
    let next: Date | null;
    try {
      next = Scheduler.validate(command.options.expr, command.options.tz);
    } catch (err) {
      await this.reply(msg.channel, anchor, `⚠️ invalid schedule: ${(err as Error).message}`);
      return;
    }
    const row = this.deps.scheduler.add({
      cron: command.options.expr,
      tz: command.options.tz,
      channel,
      agent: spec.agent,
      cwd: spec.cwd,
      model: spec.model,
      prompt: command.prompt,
      mode: command.options.mode ?? "fresh",
      createdBy: msg.user,
    });
    await this.reply(
      msg.channel,
      anchor,
      `🗓️ schedule *#${row.id}* · \`${row.cron}\`${row.tz ? ` (${row.tz})` : ""} · ${row.agent} · ${row.mode} · posts to ${channelRef(channel)}\nnext run: ${next ? next.toISOString() : "never"}`,
    );
  }

  private cronList(): string {
    const rows = this.deps.store.listSchedules();
    if (!rows.length) return "no schedules";
    return rows
      .map((row) => {
        const next = row.enabled ? this.deps.scheduler.nextRun(row.id) : null;
        const last = this.deps.store.lastRuns(row.id)[0];
        const state = !row.enabled ? "paused" : this.deps.scheduler.isRunning(row.id) ? "running" : `next ${next ? next.toISOString() : "never"}`;
        const lastText = last ? ` · last ${last.outcome ?? "running"}` : "";
        return `*#${row.id}* \`${row.cron}\`${row.tz ? ` (${row.tz})` : ""} · ${row.agent} · ${row.mode} · ${channelRef(row.channel)} · ${state}${lastText}\n> ${truncate(row.prompt.replace(/\n/g, " "), 120)}`;
      })
      .join("\n");
  }
}
