import { defaultConfig } from "../src/config.ts";
import { TelegramService } from "../src/telegram/service.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import { setCronSelection, changeSelection, forgetSession, selectionFor } from "../src/telegram/preferences.ts";
import { modelCatalog, type Provider } from "../src/telegram/providers.ts";

const cfg = { agent: "agy" as const, model: "gemini", effort: "high", fullAccess: true };
const catalog = async (provider: Provider) => provider === "codex"
  ? [{ id: "gpt", default: true as const, effortLevels: ["low", "medium"] }]
  : [{ id: "gemini", default: true as const, effortLevels: ["low", "high"] }];

test("provider and reasoning stay local to the topic and survive a switch back", async () => {
  const store = new Store(":memory:");
  try {
    const cmd = (command: "model" | "provider" | "reasoning", value: string) =>
      changeSelection(store, cfg, "-12", "7", "/tmp", command, value, catalog);
    assert.equal(selectionFor(store, cfg, "-12", "7").provider, "antigravity");
    await cmd("provider", "codex");
    await cmd("model", "gpt");
    await cmd("reasoning", "medium");
    await assert.rejects(cmd("reasoning", "high"), /does not support/);
    await assert.rejects(cmd("model", "missing"), /not available/);
    await cmd("provider", "agy");
    assert.equal(selectionFor(store, cfg, "-12", "7").effort, "high");
    await cmd("provider", "codex");
    assert.deepEqual(selectionFor(store, cfg, "-12", "7"), { provider: "codex", model: "gpt", effort: "medium" });
    assert.equal(selectionFor(store, cfg, "-12", "8").provider, "antigravity");
    assert.equal(selectionFor(store, cfg, "12", "7").provider, "antigravity");
  } finally { store.close(); }
});

test("new conversation clears legacy agy history and only the selected provider", () => {
  const store = new Store(":memory:");
  try {
    for (const [key, agent] of [["0", "agy"], ["0:antigravity", "antigravity"], ["0:codex", "codex"]]) {
      store.upsertThread({ channel: "12", thread_ts: key, agent, session_id: "native", cwd: "/tmp", model: null, kind: "chat" });
    }
    forgetSession(store, "12", "0", "antigravity");
    assert.equal(store.getThread("12", "0"), undefined);
    assert.equal(store.getThread("12", "0:antigravity"), undefined);
    assert.equal(store.getThread("12", "0:codex")?.session_id, "native");
  } finally { store.close(); }
});

test("refuses Antigravity auto-approval before installation or model discovery", async () => {
  await assert.rejects(modelCatalog("antigravity", "/tmp", false), /fullAccess/);
});

test("all Telegram agent schedules use the validated global selection on their next firing", async t => {
  const store = new Store(":memory:");
  try {
    const scheduler = new TelegramService({ ...defaultConfig, telegram: cfg }, store, { send: async () => ({ message_id: 1 }) });
    const turn = t.mock.method(scheduler, "turn", async () => {});
    const row = { channel: "123", created_by: "123", cwd: "/tmp", mode: "fresh" as const, silent: true, cron: "0 0 * * *", prompt: "report" };
    const first = store.addSchedule({ ...row, agent: "agy", model: "legacy" });
    await setCronSelection(store, cfg, "/tmp", "set codex gpt medium", catalog);
    await assert.rejects(setCronSelection(store, cfg, "/tmp", "set codex missing", catalog));
    await assert.rejects(setCronSelection(store, cfg, "/tmp", "set codex gpt invalid", catalog));
    const second = store.addSchedule({ ...row, agent: "old", model: null });
    for (const job of [first, second]) {
      await scheduler.fire(job.id);
      assert.deepEqual(turn.mock.calls.at(-1)?.arguments[3]?.selection, { provider: "codex", model: "gpt", effort: "medium" });
    }
    await setCronSelection(store, cfg, "/tmp", "set agy gemini low", catalog);
    await scheduler.fire(first.id);
    assert.equal(turn.mock.calls.at(-1)?.arguments[3]?.selection?.effort, "low");
    assert.equal(selectionFor(store, cfg, "123", "0").effort, "high");
  } finally { store.close(); }
});

test("a settings change during the start notification applies to the next firing", async t => {
  const store = new Store(":memory:");
  try {
    await setCronSelection(store, cfg, "/tmp", "set codex gpt medium", catalog);
    const scheduler = new TelegramService({ ...defaultConfig, telegram: cfg }, store, {
      async send() {
        await setCronSelection(store, cfg, "/tmp", "set agy gemini low", catalog);
        return { message_id: 1 };
      },
    });
    const turn = t.mock.method(scheduler, "turn", async () => {});
    const job = store.addSchedule({ channel: "123", created_by: "123", cwd: "/tmp", mode: "fresh",
      cron: "0 0 * * *", agent: "agy", prompt: "report" });
    await scheduler.fire(job.id);
    await scheduler.fire(job.id);
    assert.deepEqual(turn.mock.calls.map(call => call.arguments[3]?.selection?.provider), ["codex", "antigravity"]);
  } finally { store.close(); }
});
