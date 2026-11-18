import { WebClient } from "@slack/web-api";
import { createBridge, createDrivers } from "./bridge.ts";
import { expandHome, loadConfig } from "./config.ts";
import { pruneAttachments } from "./core/attachments.ts";
import { WebSlackApi } from "./slack/api.ts";
import { createSlackApp } from "./slack/app.ts";

const botToken = process.env.SLACK_BOT_TOKEN;
const appToken = process.env.SLACK_APP_TOKEN;
if (!botToken || !appToken) {
  console.error("SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set");
  process.exit(2);
}

const config = loadConfig();
const client = new WebClient(botToken);
const auth = await client.auth.test();
const bridge = createBridge({
  config,
  api: new WebSlackApi(client),
  botUserId: auth.user_id!,
  teamId: auth.team_id,
  drivers: createDrivers(config, { memoryCap: true }),
});
const { store, backfill } = bridge;
const app = createSlackApp({
  botToken,
  appToken,
  teamId: auth.team_id,
  botUserId: auth.user_id!,
  onMessage: (msg) => bridge.router.handle(msg),
  onConnected: () => void backfill.run(Date.now() - Math.min(config.backfillMinutes, 10) * 60_000),
});

// Where the last run left off: messages after it that were never handled get picked up.
const aliveAt = Number(store.getMeta("alive_at") ?? 0);
const heartbeat = () => store.setMeta("alive_at", String(Date.now()));
heartbeat();
const timers = [
  setInterval(heartbeat, 60_000),
  // Cheap safety net for events Socket Mode dropped while connected.
  setInterval(() => void backfill.run(Date.now() - 5 * 60_000), 120_000),
  setInterval(() => {
    store.pruneHandled(7 * 86_400_000);
    pruneAttachments(expandHome(config.filesDir), config.fileRetentionDays);
  }, 6 * 3_600_000),
];
pruneAttachments(expandHome(config.filesDir), config.fileRetentionDays);

bridge.manager.start();
void bridge.scheduler.start();
await app.start();
if (aliveAt) {
  const since = Math.max(aliveAt - 60_000, Date.now() - config.backfillMinutes * 60_000);
  const n = await backfill.run(since);
  if (n) console.log(`backfill: looked at ${n} message(s) since ${new Date(since).toISOString()}`);
}
console.log(`agent-bridge up as @${auth.user} (${auth.user_id}); agents: ${Object.keys(config.agents).join(", ")}; schedules: ${store.listSchedules().length}`);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: shutting down`);
    for (const t of timers) clearInterval(t);
    void (async () => {
      await app.stop().catch(() => {});
      await bridge.shutdown();
      process.exit(0);
    })();
  });
}
