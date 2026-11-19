import { setTimeout as delay } from "node:timers/promises";
import { loadConfig, expandHome } from "../config.ts";
import { Store } from "../store.ts";
import { configuredBot } from "./api.ts";
import { route, type TelegramMessage } from "./route.ts";
import { TelegramService } from "./service.ts";

const config = loadConfig();
if (!/^\d+$/.test(config.ownerUserId) || !config.telegram?.model || !config.telegram.effort) throw new Error("Telegram requires numeric ownerUserId and telegram model/effort");
const bot = configuredBot();
const me = await bot.call("getMe", {});
const store = new Store(expandHome(config.dbPath));
const scheduler = new TelegramService(config, store, bot);
const drafts = new Map<number, AbortController>();
const shutdown = new AbortController();
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
  if (command === "start" || command === "help") return send("直接发消息给 Codex。群内请 @ 我或回复我。/new 新会话 · /stop 停止 · /cron 查看任务 · /html 以 HTML 回答");
  if (command === "cron") return send(store.listSchedules().map(r => `#${r.id} ${r.name} · ${r.cron} · ${r.tz ?? "local"} · ${scheduler.nextRun(r.id)?.toISOString() ?? "paused"}`).join("\n") || "没有任务");
  if (command === "stop") {
    active.get(key)?.abort();
    return send("已处理停止请求。");
  }
  if (active.has(key)) return send("当前会话正在运行。可用 /stop 停止。");
  if (command === "new") {
    store.db.prepare("DELETE FROM threads WHERE channel=? AND thread_ts=?").run(target.chat_id, topic);
    return send("下一条消息将开启新会话。");
  }
  if (command && !["ask","html"].includes(command)) return send("可用命令见 /help");
  const prompt = text;
  if (!prompt) return send("请输入问题。");
  if (active.size >= config.maxLiveSessions) return send("所有 Codex 会话均在运行，请稍后重试。");
  const control = new AbortController();
  active.set(key, control);
  const dm = message.chat.type === "private";
  const draftId = message.message_id;
  const progress = async () => {
    if (dm) {
      try {
        await bot.call("sendRichMessageDraft", { ...target, draft_id: draftId, can_stop: true, rich_message: { html: "<tg-thinking>Codex 正在处理…</tg-thinking>" } });
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
    if (!shutdown.signal.aborted) await send("Codex: " + (err as Error).message);
  } finally {
    clearInterval(heartbeat);
    if (dm) drafts.delete(draftId);
    active.delete(key);
  }
}

store.pruneHandled(7 * 86400_000);
store.db.prepare("UPDATE runs SET ended_at=?, outcome='interrupted' WHERE ended_at IS NULL").run(Date.now());
const commands = [
  ["help", "使用说明"], ["ask", "向 Codex 提问"], ["new", "开启新的 Codex 会话"],
  ["html", "使用 HTML 富文本回答"], ["stop", "停止当前会话"], ["cron", "查看定时任务及下次执行时间"],
].map(([command, description]) => ({ command, description }));
for (const scope of [{ type: "default" }, { type: "chat", chat_id: config.ownerUserId }]) {
  await bot.call("setMyCommands", { scope, commands }).catch(err => console.error("Telegram menu:", err.message));
}
// Catch-up can run long Codex jobs. Continue polling while historical runs finish.
void scheduler.start().catch(err => console.error("Telegram cron catch-up:", err.message));
console.log(`Telegram @${me.username} ready, ${store.listSchedules().filter(r => r.enabled).length} enabled schedules`);
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
