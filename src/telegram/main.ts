import { setTimeout as delay } from "node:timers/promises";
import { describeCronSelection, setCronSelection, forgetSession, selectionFor, changeSelection } from "./preferences.ts";
import { cronCommand } from "./cron.ts";
import { defaults } from "./providers.ts";
import { loadConfig, expandHome } from "../config.ts";
import { Store } from "../store.ts";
import { configuredBot } from "./api.ts";
import { route, type TelegramMessage } from "./route.ts";
import { TelegramService } from "./service.ts";

const config = loadConfig();
if (!/^\d+$/.test(config.ownerUserId) || !config.telegram) throw new Error("Telegram requires numeric ownerUserId and telegram configuration");
const bot = configuredBot();
const me = await bot.call("getMe", {});
const store = new Store(expandHome(config.dbPath));
const scheduler = new TelegramService(config, store, bot);
const drafts = new Map<number, AbortController>();
const shutdown = new AbortController();
let updatingCron = false;
const helpText = [
  "Message me to talk to the current agent (in groups, mention me or reply to me).",
  "/provider, /model, /reasoning — show or switch the backend for this chat/topic.",
  "/new — new conversation · /stop — stop the running turn · /html <prompt> — answer in rich HTML.",
  "/cron — add, list, run, pause, resume and remove schedules; /cron set picks their provider and model.",
].join("\n");
const configuring = new Set<string>();
const active = new Map<string, AbortController>();
for (const sig of ["SIGTERM", "SIGINT"]) process.once(sig, () => {
  scheduler.stop();
  shutdown.abort();
  for (const control of active.values()) control.abort();
});

async function handle(message: TelegramMessage) {
  const input = route(message, config.ownerUserId, me);
  if (!input) return;
  const { target, topic, text, command } = input;
  const key = target.chat_id + ":" + topic;
  const send = (s: string) => bot.send(target, s);
  if (command === "start" || command === "help") return send(helpText);
  if (command === "cron") {
    if (!/^set(\s|$)/i.test(text)) return send(await cronCommand(text, { config, store, scheduler, target, send }));
    if (updatingCron) return send("Schedule settings are being updated; try again in a moment.");
    updatingCron = true;
    let reply: string;
    try {
      const selection = await setCronSelection(store, config.telegram!, expandHome(config.defaultCwd), text);
      reply = describeCronSelection(selection) + ". Applies from the next agent schedule run.";
    } catch (err) {
      reply = (err as Error).message;
    } finally {
      updatingCron = false;
    }
    return send(reply);
  }
  if (command === "stop") {
    active.get(key)?.abort();
    return send("Stopping.");
  }
  if (configuring.has(key)) return send("Settings are being read or updated; try again in a moment.");
  if (active.has(key)) return send("A turn is already running here. Send /stop to stop it.");
  if (command === "provider" || command === "model" || command === "reasoning") {
    configuring.add(key);
    try {
      const reply = await changeSelection(store, config.telegram!, target.chat_id, topic,
        expandHome(config.defaultCwd), command, text);
      return await send(reply);
    } catch (err) {
      return await send((err as Error).message);
    } finally {
      configuring.delete(key);
    }
  }
  if (command === "new") {
    forgetSession(store, target.chat_id, topic, selectionFor(store, config.telegram!, target.chat_id, topic).provider);
    return send("The next message starts a new conversation.");
  }
  if (command && !["ask","html"].includes(command)) return send("Unknown command. Send /help for the list.");
  const prompt = text;
  if (!prompt) return send("Send a prompt after the command.");
  if (active.size >= config.maxLiveSessions) return send("All agent slots are busy; try again shortly.");
  const control = new AbortController();
  active.set(key, control);
  const dm = message.chat.type === "private";
  const draftId = message.message_id;
  const progress = async () => {
    if (dm) {
      try {
        await bot.call("sendRichMessageDraft", { ...target, draft_id: draftId, can_stop: true, rich_message: { html: "<tg-thinking>Working…</tg-thinking>" } });
        return;
      } catch { /* older Bot API or unsupported draft */ }
    }
    await bot.call("sendChatAction", { ...target, action: "typing" }).catch(() => {});
  };
  if (dm) drafts.set(draftId, control);
  const heartbeat = setInterval(() => void progress(), 24000);
  try {
    void progress();
    await scheduler.turn(target, topic, command === "html" ? "Respond in Telegram rich-message HTML.\n" + prompt : prompt,
      { timeout: config.runTimeoutMinutes, resume: true, signal: control.signal, format: command === "html" ? "html" : "markdown" });
  } catch (err) {
    if (!shutdown.signal.aborted) await send("Agent: " + (err as Error).message);
  } finally {
    clearInterval(heartbeat);
    if (dm) drafts.delete(draftId);
    active.delete(key);
  }
}

store.pruneHandled(7 * 86400_000);
store.db.prepare("UPDATE runs SET ended_at=?, outcome='interrupted' WHERE ended_at IS NULL").run(Date.now());
const commands = [
  ["help", "How to use this bot"], ["ask", "Ask the current agent"], ["new", "Start a new conversation"],
  ["provider", "Show or switch the provider"], ["model", "Show or switch the model"], ["reasoning", "Show or switch the reasoning level"],
  ["html", "Answer in rich HTML"], ["stop", "Stop the running turn"], ["cron", "Add, list and manage schedules"],
].map(([command, description]) => ({ command, description }));
for (const scope of [{ type: "default" }, { type: "chat", chat_id: config.ownerUserId }]) {
  await bot.call("setMyCommands", { scope, commands }).catch(err => console.error("Telegram menu:", err.message));
}
// Catch-up can run long Codex jobs. Continue polling while historical runs finish.
void scheduler.start().catch(err => console.error("Telegram cron catch-up:", err.message));
console.log(`Telegram @${me.username} ready (${defaults(config.telegram).provider}), ${store.listSchedules().filter(r => r.enabled).length} enabled schedules`);
let offset = Number(store.getMeta("telegram_offset") ?? 0);
const pending = new Set<Promise<unknown>>();
while (!shutdown.signal.aborted) {
  try {
    const updates = await bot.call("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "stopped_message_generation"] },
      AbortSignal.any([shutdown.signal, AbortSignal.timeout(40_000)]));
    for (const u of updates) {
      const stop = u.stopped_message_generation;
      if (stop?.chat.type === "private" && String(stop.chat.id) === config.ownerUserId) drafts.get(stop.draft_id)?.abort();
      if (u.message && store.claimMessage("telegram-update", String(u.update_id))) {
        const task = handle(u.message).catch(err => console.error("Telegram dispatch:", err.message));
        pending.add(task);
        void task.finally(() => pending.delete(task));
      }
      offset = u.update_id + 1;
      store.setMeta("telegram_offset", String(offset));
    }
  } catch (err) {
    if (!shutdown.signal.aborted) {
      console.error((err as Error).message);
      await delay(2500);
    }
  }
}
await Promise.allSettled(pending);
