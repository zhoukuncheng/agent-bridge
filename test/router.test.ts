import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { after, test } from "node:test";
import { createBridge } from "../src/bridge.ts";
import { defaultConfig, type Config } from "../src/config.ts";
import type { InboundMessage } from "../src/core/router.ts";
import { Store } from "../src/store.ts";
import { FakeDriver, FakeSlack, waitFor } from "./fakes.ts";

const OWNER = "UOWNER";
const bridges: { shutdown(): Promise<void> }[] = [];
after(() => Promise.all(bridges.map((b) => b.shutdown())));
const BOT = "UBOT";

function setup(overrides: Partial<Config> = {}) {
  const config: Config = { ...defaultConfig, ownerUserId: OWNER, allowUsers: [OWNER], defaultCwd: tmpdir(), maxLiveSessions: 2, ...overrides };
  const slack = new FakeSlack();
  const drivers = { claude: new FakeDriver("claude"), omp: new FakeDriver("omp") };
  const bridge = createBridge({ config, api: slack, botUserId: BOT, teamId: "T1", drivers, store: new Store(":memory:"), renderOptions: { flushMs: 1 } });
  bridges.push(bridge);
  let ts = 1;
  const msg = (text: string, extra: Partial<InboundMessage> = {}): InboundMessage => ({
    channel: "C1",
    channelType: "channel",
    user: OWNER,
    text,
    ts: `1800000000.${String(ts++).padStart(6, "0")}`,
    ...extra,
  });
  return { config, slack, drivers, bridge, msg };
}

const settle = (bridge: ReturnType<typeof setup>["bridge"]) => Promise.all([...bridge.router.background]);

test("ignores strangers, and channel messages that neither mention the bot nor reply in its thread", async () => {
  const { bridge, slack, msg } = setup();
  await bridge.router.handle(msg(`<@${BOT}> hi`, { user: "USTRANGER" }));
  await bridge.router.handle(msg("hi there"));
  await bridge.router.handle(msg("reply in someone else's thread", { threadTs: "1.0" }));
  assert.equal(slack.calls.length, 0);
});

test("a mention starts a session in a thread; replies continue it; the answer streams", async () => {
  const { bridge, slack, drivers, msg } = setup();
  const root = msg(`<@${BOT}> first question`);
  await bridge.router.handle(root);
  await waitFor(() => slack.calls.some((c) => c.method === "stopStream"));
  assert.equal(drivers.claude.sessions.length, 1);
  assert.match(slack.posts(root.ts)[0]!.text, /🤖 \*claude\*/);
  assert.match(slack.textIn(root.ts), /echo: first question/);
  const stream = slack.calls.find((c) => c.method === "startStream") as { thread_ts: string; recipient_user_id?: string };
  assert.equal(stream.thread_ts, root.ts);
  assert.equal(stream.recipient_user_id, OWNER);

  await bridge.router.handle(msg("follow-up without mention", { threadTs: root.ts }));
  await waitFor(() => slack.calls.filter((c) => c.method === "stopStream").length === 2);
  assert.equal(drivers.claude.sessions.length, 1);
  assert.deepEqual(drivers.claude.sessions[0]!.inputs, ["first question", "follow-up without mention"]);
});

test("DMs need no mention and stream without a recipient", async () => {
  const { bridge, slack, msg } = setup();
  await bridge.router.handle(msg("hello", { channel: "D1", channelType: "im" }));
  await waitFor(() => slack.calls.some((c) => c.method === "stopStream"));
  assert.equal((slack.calls.find((c) => c.method === "startStream") as { recipient_user_id?: string }).recipient_user_id, undefined);
});

test("!chat picks the agent; the thread keeps it", async () => {
  const { bridge, slack, drivers, msg } = setup();
  const root = msg(`<@${BOT}> !chat --agent omp do it`);
  await bridge.router.handle(root);
  await waitFor(() => drivers.omp.sessions[0]?.inputs.length === 1);
  await bridge.router.handle(msg("!chat --agent claude switch?", { threadTs: root.ts }));
  assert.match(slack.posts(root.ts).at(-1)!.text, /this thread runs \*omp\*/);
  assert.equal(drivers.claude.sessions.length, 0);
});

test("messages during a turn are queued; !stop aborts", async () => {
  const { bridge, slack, drivers, msg } = setup();
  const root = msg(`<@${BOT}> HANG`);
  await bridge.router.handle(root);
  await waitFor(() => drivers.claude.sessions[0]?.running === true);
  await bridge.router.handle(msg("more", { threadTs: root.ts }));
  assert.match(slack.posts(root.ts).at(-1)!.text, /queued/);
  await bridge.router.handle(msg("!stop", { threadTs: root.ts }));
  await waitFor(() => slack.textIn(root.ts).includes("echo: more"));
  assert.match(slack.textIn(root.ts), /⏹️ aborted/);
  await bridge.router.handle(msg("!stop", { threadTs: root.ts }));
  assert.match(slack.posts(root.ts).at(-1)!.text, /nothing is running/);
});

test("a released or evicted session is resumed from the stored id", async () => {
  const { bridge, slack, drivers, msg } = setup({ maxLiveSessions: 1 });
  const a = msg(`<@${BOT}> one`);
  await bridge.router.handle(a);
  await waitFor(() => slack.calls.filter((c) => c.method === "stopStream").length === 1);
  const b = msg(`<@${BOT}> two`);
  await bridge.router.handle(b); // evicts a's idle session
  await waitFor(() => slack.calls.filter((c) => c.method === "stopStream").length === 2);
  assert.equal(drivers.claude.sessions[0]!.disposed, true);
  await bridge.router.handle(msg("back to one", { threadTs: a.ts }));
  await waitFor(() => slack.calls.filter((c) => c.method === "stopStream").length === 3);
  const resumed = drivers.claude.sessions.at(-1)!;
  assert.equal(resumed.resumedFrom, drivers.claude.sessions[0]!.id);
  assert.deepEqual(resumed.inputs, ["back to one"]);
  assert.equal(slack.posts(a.ts).filter((p) => p.text.startsWith("🤖")).length, 1);
});

test("!run runs once, records the run and frees the process; the thread can continue", async () => {
  const { bridge, slack, drivers, msg } = setup();
  const root = msg(`<@${BOT}> !run --agent omp TOOL check`);
  await bridge.router.handle(root);
  await settle(bridge);
  const session = drivers.omp.sessions[0]!;
  assert.equal(session.disposed, true);
  assert.match(slack.textIn(root.ts), /echo: TOOL check/);
  assert.equal(bridge.manager.liveCount(), 0);
  const run = bridge.store.db.prepare("SELECT * FROM runs").get() as { outcome: string; schedule_id: number | null };
  assert.equal(run.outcome, "completed");
  assert.equal(run.schedule_id, null);
  const tasks = slack.calls.filter((c) => c.method === "appendStream").flatMap((c) => (c as { chunks: any[] }).chunks).filter((c) => c.type === "task_update");
  assert.equal(tasks.at(-1).status, "complete");

  await bridge.router.handle(msg("and then?", { threadTs: root.ts }));
  await waitFor(() => drivers.omp.sessions.length === 2 && drivers.omp.sessions[1]!.inputs.length === 1);
  assert.equal(drivers.omp.sessions[1]!.resumedFrom, session.id);
});

test("!run times out and aborts", async () => {
  const { bridge, slack, msg } = setup();
  const root = msg(`<@${BOT}> !run --timeout 0.001 HANG`);
  await bridge.router.handle(root);
  await settle(bridge);
  assert.match(slack.textIn(root.ts), /⏹️ aborted/);
  const run = bridge.store.db.prepare("SELECT * FROM runs").get() as { outcome: string; error: string };
  assert.equal(run.outcome, "aborted");
  assert.match(run.error, /timed out/);
});

test("!cron add / list / run / pause / rm", async () => {
  const { bridge, slack, drivers, msg } = setup();
  const add = msg(`<@${BOT}> !cron add "0 9 * * *" --agent omp --channel dm --tz Asia/Shanghai daily digest`);
  await bridge.router.handle(add);
  assert.match(slack.posts(add.ts).at(-1)!.text, /schedule \*#1\*.*omp · fresh · posts to DM/s);
  const row = bridge.store.getSchedule(1)!;
  assert.equal(row.channel, "DOWNER");
  assert.equal(row.tz, "Asia/Shanghai");

  const list = msg(`<@${BOT}> !cron list`);
  await bridge.router.handle(list);
  assert.match(slack.posts(list.ts).at(-1)!.text, /#1\* `0 9 \* \* \*` \(Asia\/Shanghai\) · omp · fresh · DM · next 20/);

  await bridge.router.handle(msg(`<@${BOT}> !cron run 1`));
  await settle(bridge);
  const header = slack.posts().find((p) => p.channel === "DOWNER" && !p.thread_ts)!;
  assert.match(header.text, /⏰ \*daily digest\* · #1 · omp/);
  assert.match(slack.textIn(header.ts), /echo: daily digest/);
  assert.equal(drivers.omp.sessions[0]!.disposed, true);
  assert.equal((bridge.store.lastRuns(1)[0]!).outcome, "completed");

  await bridge.router.handle(msg(`<@${BOT}> !cron pause 1`));
  assert.equal(bridge.store.getSchedule(1)!.enabled, 0);
  const rm = msg(`<@${BOT}> !cron rm 1`);
  await bridge.router.handle(rm);
  assert.match(slack.posts(rm.ts).at(-1)!.text, /removed/);
  assert.equal(bridge.store.listSchedules().length, 0);
});

test("continue-mode schedules reuse one thread and resume its session", async () => {
  const { bridge, slack, drivers, msg } = setup();
  await bridge.router.handle(msg(`<@${BOT}> !cron add "0 0 1 1 *" --mode continue tick`));
  await bridge.scheduler.fire(1);
  await bridge.scheduler.fire(1);
  const headers = slack.posts().filter((p) => p.text.startsWith("⏰ *tick*"));
  assert.equal(headers.length, 1);
  assert.equal(bridge.store.getSchedule(1)!.thread_ts, headers[0]!.ts);
  assert.equal(drivers.claude.sessions.length, 2);
  assert.equal(drivers.claude.sessions[1]!.resumedFrom, drivers.claude.sessions[0]!.id);
  assert.equal(slack.textIn(headers[0]!.ts).match(/echo: tick/g)?.length, 2);
});

test("cron fires on its own schedule (seconds field)", async () => {
  const { bridge, slack, msg } = setup();
  bridge.scheduler.start();
  await bridge.router.handle(msg(`<@${BOT}> !cron add "* * * * * *" every second`));
  await waitFor(() => slack.textIn(slack.posts().find((p) => p.text.startsWith("⏰"))?.ts ?? "x").includes("echo: every second"), 3000);
  bridge.scheduler.stop();
});

test("validation errors are reported in the thread", async () => {
  const { bridge, slack, msg } = setup();
  const bad = msg(`<@${BOT}> !cron add "not a cron" x`);
  await bridge.router.handle(bad);
  assert.match(slack.posts(bad.ts).at(-1)!.text, /invalid schedule/);
  const badCwd = msg(`<@${BOT}> !chat --cwd /definitely/missing x`);
  await bridge.router.handle(badCwd);
  assert.match(slack.posts(badCwd.ts).at(-1)!.text, /working directory does not exist/);
  const badAgent = msg(`<@${BOT}> !run --agent nope x`);
  await bridge.router.handle(badAgent);
  assert.match(slack.posts(badAgent.ts).at(-1)!.text, /unknown agent "nope"/);
});

test("!new is an alias of !chat", async () => {
  const { bridge, drivers, msg } = setup();
  await bridge.router.handle(msg(`<@${BOT}> !new --agent omp hello`));
  await waitFor(() => drivers.omp.sessions[0]?.inputs[0] === "hello");
});

test("mentioned in someone else's thread: the agent gets the earlier messages", async () => {
  const { bridge, slack, drivers, msg } = setup();
  slack.threads.set("1700.000100", [
    { ts: "1700.000100", user: "UALICE", text: "prod is throwing 502s on /api/x" },
    { ts: "1700.000200", user: "UBOB", text: "started after the 14:00 deploy &amp; only in us-east" },
    { ts: "1800.000000", user: OWNER, text: "later message" },
  ]);
  await bridge.router.handle(msg(`<@${BOT}> what changed?`, { threadTs: "1700.000100", ts: "1700.000300" }));
  await waitFor(() => drivers.claude.sessions[0]?.inputs.length === 1);
  const input = drivers.claude.sessions[0]!.inputs[0]!;
  assert.match(input, /name-of-UALICE: prod is throwing 502s/);
  assert.match(input, /name-of-UBOB: started after the 14:00 deploy & only in us-east/);
  assert.doesNotMatch(input, /later message/);
  assert.match(input, /The request:\nwhat changed\?$/);
  // A reply in the now-owned thread is sent as is.
  await bridge.router.handle(msg("and before that?", { threadTs: "1700.000100" }));
  await waitFor(() => drivers.claude.sessions[0]!.inputs.length === 2);
  assert.equal(drivers.claude.sessions[0]!.inputs[1], "and before that?");
});

test("exec schedules post the command output; failures show the exit code", async () => {
  const { bridge, slack, msg } = setup();
  await bridge.router.handle(msg(`<@${BOT}> !cron add "0 0 1 1 *" --exec --name probe echo out-1; echo err-1 >&2`));
  await bridge.router.handle(msg(`<@${BOT}> !cron add "0 0 1 1 *" --exec --timeout 1 exit 3`));
  await bridge.scheduler.fire(1);
  await bridge.scheduler.fire(2);
  const posts = slack.posts().filter((p) => !p.thread_ts);
  assert.match(posts.at(-2)!.text, /^⏰ ✅ \*probe\* · `echo out-1; echo err-1 >&2`\n\nout-1\nerr-1$/);
  assert.match(posts.at(-1)!.text, /^⏰ ❌ .*error: exit code 3$/s);
  assert.equal(bridge.store.lastRuns(1)[0]!.outcome, "completed");
  assert.equal(bridge.store.lastRuns(2)[0]!.outcome, "failed");
  const list = msg(`<@${BOT}> !cron list`);
  await bridge.router.handle(list);
  assert.match(slack.posts(list.ts).at(-1)!.text, /#1\* \*probe\* `0 0 1 1 \*` · exec/);
});

test("silent schedules post only the final answer, and its thread resumes the session", async () => {
  const { bridge, slack, drivers, msg } = setup();
  await bridge.router.handle(msg(`<@${BOT}> !cron add "0 0 1 1 *" --silent --agent omp TOOL quiet report`));
  const before = slack.calls.length;
  await bridge.scheduler.fire(1);
  const calls = slack.calls.slice(before);
  assert.deepEqual(calls.map((c) => c.method), ["postMessage"]);
  const post = calls[0] as { text: string; ts: string; thread_ts?: string };
  assert.equal(post.text, "echo: TOOL quiet report");
  assert.equal(post.thread_ts, undefined);
  assert.equal(drivers.omp.sessions[0]!.disposed, true);
  await bridge.router.handle(msg("follow up", { threadTs: post.ts }));
  await waitFor(() => drivers.omp.sessions[1]?.inputs[0] === "follow up");
  assert.equal(drivers.omp.sessions[1]!.resumedFrom, drivers.omp.sessions[0]!.id);
});

test("silent schedules stay quiet on NO_REPLY and report failures", async () => {
  const { bridge, slack, msg } = setup();
  await bridge.router.handle(msg(`<@${BOT}> !cron add "0 0 1 1 *" --silent NOREPLY`));
  await bridge.router.handle(msg(`<@${BOT}> !cron add "0 0 1 1 *" --silent FAIL`));
  let before = slack.calls.length;
  await bridge.scheduler.fire(1);
  assert.equal(slack.calls.length, before);
  assert.equal(bridge.store.lastRuns(1)[0]!.outcome, "completed");
  before = slack.calls.length;
  await bridge.scheduler.fire(2);
  const post = slack.calls.slice(before)[0] as { text: string };
  assert.match(post.text, /^⏰ ❌ \*FAIL\* failed: boom\n\necho: FAIL$/);
});
