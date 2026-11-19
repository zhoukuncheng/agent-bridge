import assert from "node:assert/strict";
import { antigravityRuntime } from "@botiverse/oar/runtimes/antigravity";
import { codexRuntime } from "@botiverse/oar/runtimes/codex";
import { defaultConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";
import { TelegramService } from "../src/telegram/service.ts";

assert.equal(codexRuntime.id, "codex");
assert.equal(antigravityRuntime.id, "antigravity");

const store = new Store(":memory:");
try {
  const deliveries: { chatId: string; text: string }[] = [];
  const service = new TelegramService(defaultConfig, store, {
    async send(target, text) {
      deliveries.push({ chatId: target.chat_id, text });
      return { message_id: 1 };
    },
  });
  const schedule = store.addSchedule({
    name: "Bun smoke",
    channel: "test-chat",
    created_by: "ci",
    agent: "codex",
    cwd: process.cwd(),
    mode: "fresh",
    exec: true,
    silent: true,
    cron: "0 0 * * *",
    prompt: "printf bridge-ci-ok",
  });

  assert.equal(await service.fire(schedule.id), true);
  assert.deepEqual(deliveries, [{ chatId: "test-chat", text: "bridge-ci-ok" }]);
  assert.equal(store.lastRuns(schedule.id)[0]?.outcome, "completed");
} finally {
  store.close();
}
