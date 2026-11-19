import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import { changeSelection, forgetSession, selectionFor } from "../src/telegram/preferences.ts";
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
    await assert.rejects(cmd("reasoning", "high"), /不支持/);
    await assert.rejects(cmd("model", "missing"), /可用列表/);
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
