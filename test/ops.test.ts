import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createBridge } from "../src/bridge.ts";
import { defaultConfig, type Config } from "../src/config.ts";
import { SessionBinding } from "../src/core/binding.ts";
import { toInbound } from "../src/slack/app.ts";
import { Store } from "../src/store.ts";
import { FakeDriver, FakeSession, FakeSlack, waitFor } from "./fakes.ts";

const OWNER = "UOWNER";
const BOT = "UBOT";
const bridges: { shutdown(): Promise<void> }[] = [];
after(() => Promise.all(bridges.map((b) => b.shutdown())));

function setup(overrides: Partial<Config> = {}) {
  const config: Config = { ...defaultConfig, ownerUserId: OWNER, allowUsers: [OWNER], defaultCwd: tmpdir(), filesDir: mkdtempSync(join(tmpdir(), "bridge-files-")), ...overrides };
  const slack = new FakeSlack();
  const drivers = { claude: new FakeDriver("claude"), omp: new FakeDriver("omp") };
  const bridge = createBridge({ config, api: slack, botUserId: BOT, teamId: "T1", drivers, store: new Store(":memory:"), renderOptions: { flushMs: 1, holdMs: 5, cardMs: 1 } });
  bridges.push(bridge);
  return { config, slack, drivers, bridge };
}

test("stall watchdog warns once, then aborts when configured", async () => {
  const slack = new FakeSlack();
  const session = new FakeSession("claude", "s1");
  const binding = new SessionBinding(session, slack, { channel: "C1", threadTs: "1.0" }, { flushMs: 1 }, { warnMinutes: 0.0005, abortMinutes: 0.002, checkMs: 10 });
  const ended = binding.nextTurnEnd();
  await binding.send("HANG");
  await waitFor(() => slack.posts("1.0").some((p) => p.text.startsWith("⚠️ no activity")));
  const result = await ended;
  assert.equal(result.outcome, "aborted");
  assert.equal(result.error, "stopped by the stall watchdog");
  assert.equal(slack.posts("1.0").filter((p) => p.text.startsWith("⚠️ no activity")).length, 1);
  assert.ok(slack.posts("1.0").some((p) => p.text.includes("stopping the turn")));
  await binding.dispose();
});

test("backfill routes owner messages Socket Mode never delivered, once", async () => {
  const { bridge, slack, drivers } = setup();
  const now = Date.now() / 1000;
  slack.channelHistory.set("DOWNER", [
    { ts: (now - 30).toFixed(6), user: OWNER, text: "missed while down" },
    { ts: (now - 20).toFixed(6), user: "USOMEONE", text: "not the owner" },
    { ts: (now - 10).toFixed(6), user: BOT, bot_id: "B1", text: "bot's own" },
  ]);
  await bridge.backfill.run(Date.now() - 60_000);
  await waitFor(() => drivers.claude.sessions[0]?.inputs[0] === "missed while down");
  await bridge.backfill.run(Date.now() - 60_000);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(drivers.claude.sessions.length, 1);

  // A reply dropped inside one of the bridge's threads is picked up too.
  const root = (now - 30).toFixed(6);
  slack.threads.set(root, [
    { ts: root, user: OWNER, text: "missed while down" },
    { ts: (now - 5).toFixed(6), user: OWNER, text: "dropped reply", thread_ts: root },
  ]);
  await bridge.backfill.run(Date.now() - 60_000);
  await waitFor(() => drivers.claude.sessions[0]!.inputs.includes("dropped reply"));
});

test("missed cron firings are caught up once and the owner is told", async () => {
  const { bridge, slack, drivers } = setup();
  const row = bridge.scheduler.add({ cron: "0 * * * *", channel: "C1", agent: "omp", cwd: tmpdir(), prompt: "hourly", mode: "fresh", silent: true, createdBy: OWNER, name: "hourly check" });
  bridge.scheduler.stop();
  // Created two hours ago, never run: the last top-of-hour was missed.
  bridge.store.db.prepare("UPDATE schedules SET created_at = ? WHERE id = ?").run(Date.now() - 2 * 3_600_000, row.id);
  await bridge.scheduler.start();
  bridge.scheduler.stop();
  const notice = slack.posts().find((p) => p.channel === "DOWNER");
  assert.match(notice!.text, /schedule #1 \*hourly check\* missed its .* run while the bridge was down; running it now/);
  assert.equal(drivers.omp.sessions.length, 1);
  assert.equal(bridge.store.lastRuns(1)[0]!.outcome, "completed");
  // Started again right away: nothing missed any more.
  await bridge.scheduler.start();
  bridge.scheduler.stop();
  assert.equal(drivers.omp.sessions.length, 1);
});

test("catch-up can be notify-only", async () => {
  const { bridge, slack, drivers } = setup({ cronCatchUp: "notify" });
  const row = bridge.scheduler.add({ cron: "0 * * * *", channel: "C1", agent: "omp", cwd: tmpdir(), prompt: "hourly", mode: "fresh", createdBy: OWNER });
  bridge.scheduler.stop();
  bridge.store.db.prepare("UPDATE schedules SET created_at = ? WHERE id = ?").run(Date.now() - 2 * 3_600_000, row.id);
  await bridge.scheduler.start();
  bridge.scheduler.stop();
  assert.match(slack.posts().find((p) => p.channel === "DOWNER")!.text, /run it with `!cron run 1`/);
  assert.equal(drivers.omp.sessions.length, 0);
});

test("an edit that adds the bot mention is routed; other edits are not", () => {
  const edit = (before: string, now: string) =>
    toInbound(
      { subtype: "message_changed", channel: "C1", channel_type: "channel", message: { user: OWNER, text: now, ts: "5.0" }, previous_message: { user: OWNER, text: before, ts: "5.0" } },
      "T1",
      BOT,
    );
  assert.equal(edit("look at this", `<@${BOT}> look at this`)?.text, `<@${BOT}> look at this`);
  assert.equal(edit(`<@${BOT}> a`, `<@${BOT}> b`), undefined);
  assert.equal(edit("a", "b"), undefined);
});

test("file_share messages carry their files", () => {
  const msg = toInbound({ subtype: "file_share", channel: "D1", user: OWNER, text: "", ts: "1.0", files: [{ id: "F1", name: "a.png" }, { id: "F2", mode: "tombstone" }] });
  assert.deepEqual(msg?.files, [{ id: "F1", name: "a.png" }]);
});
