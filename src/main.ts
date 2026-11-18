import { WebClient } from "@slack/web-api";
import { createBridge } from "./bridge.ts";
import { loadConfig } from "./config.ts";
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
const bridge = createBridge({ config, api: new WebSlackApi(client), botUserId: auth.user_id!, teamId: auth.team_id });
const app = createSlackApp({ botToken, appToken, teamId: auth.team_id, onMessage: (msg) => bridge.router.handle(msg) });

bridge.manager.start();
bridge.scheduler.start();
await app.start();
console.log(`agent-bridge up as @${auth.user} (${auth.user_id}); agents: ${Object.keys(config.agents).join(", ")}; schedules: ${bridge.store.listSchedules().length}`);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: shutting down`);
    void (async () => {
      await app.stop().catch(() => {});
      await bridge.shutdown();
      process.exit(0);
    })();
  });
}
