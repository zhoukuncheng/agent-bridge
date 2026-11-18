// End-to-end check against real Slack and real agents.
//
// Inbound events are injected into the router instead of arriving over Socket Mode:
// the bot app is shared with a running cc-connect, and Slack would split events between
// the two connections. Everything else is real: the bot posts each "user" message as a
// labelled seed, the bridge drives real claude/omp sessions, and the checks read the
// thread back through conversations.replies.
//
// Usage: scripts/with-slack-env.sh node scripts/e2e.ts [--channel YOUR_SLACK_CHANNEL_ID] [--owner YOUR_SLACK_USER_ID] [--only name,name]
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { WebClient } from "@slack/web-api";
import { createBridge } from "../src/bridge.ts";
import { defaultConfig, type Config } from "../src/config.ts";
import { WebSlackApi, type ReplyMessage } from "../src/slack/api.ts";
import { Store } from "../src/store.ts";

const { values } = parseArgs({
  options: {
    channel: { type: "string", default: "YOUR_SLACK_CHANNEL_ID" },
    owner: { type: "string", default: "YOUR_SLACK_USER_ID" },
    only: { type: "string" },
    "claude-model": { type: "string", default: "claude-haiku-5-5" },
    "omp-model": { type: "string" },
    "agy-model": { type: "string" },
  },
});
const CHANNEL = values.channel!;
const OWNER = values.owner!;
const only = values.only ? new Set(values.only.split(",")) : undefined;

const token = process.env.SLACK_BOT_TOKEN;
if (!token) throw new Error("SLACK_BOT_TOKEN is not set (run through scripts/with-slack-env.sh)");
const client = new WebClient(token);
const api = new WebSlackApi(client);
const auth = await client.auth.test();
const BOT = auth.user_id!;

const workDir = join(homedir(), "tmp", "agent-bridge-e2e");
rmSync(workDir, { recursive: true, force: true });
mkdirSync(join(workDir, "cwd"), { recursive: true });

const config: Config = {
  ...defaultConfig,
  ownerUserId: OWNER,
  allowUsers: [OWNER],
  defaultAgent: "claude",
  defaultCwd: join(workDir, "cwd"),
  agents: {
    claude: { kind: "oar", runtime: "claude", model: values["claude-model"] },
    omp: { kind: "acp", command: join(homedir(), ".local/bin/omp"), args: ["acp"], ...(values["omp-model"] ? { model: values["omp-model"] } : {}) },
    agy: { kind: "oar", runtime: "antigravity", ...(values["agy-model"] ? { model: values["agy-model"] } : {}) },
  },
  maxLiveSessions: 3,
  runTimeoutMinutes: 5,
  dbPath: join(workDir, "e2e.db"),
};
const bridge = createBridge({ config, api, botUserId: BOT, teamId: auth.team_id, store: new Store(config.dbPath) });
bridge.manager.start();
bridge.scheduler.start();
const dm = await api.openDm(OWNER);
const runTag = new Date().toISOString().slice(11, 19);

/** Posts a labelled stand-in for the user's message, then routes it as if the user had sent it. */
async function userSays(channel: string, text: string, threadTs?: string): Promise<string> {
  const { ts } = await api.postMessage({ channel, ...(threadTs ? { thread_ts: threadTs } : {}), text: `🧪 _e2e ${runTag} · as <@${OWNER}>:_ ${text}` });
  const isDm = channel.startsWith("D");
  // Like a real user: in channels, mention the bot unless replying in one of its session threads.
  const mention = !isDm && !(threadTs && bridge.manager.owns(channel, threadTs)) ? `<@${BOT}> ` : "";
  await bridge.router.handle({ channel, channelType: isDm ? "im" : "channel", user: OWNER, text: `${mention}${text}`, ts, ...(threadTs ? { threadTs } : {}), teamId: auth.team_id });
  return ts;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls the thread until a bot message after `afterTs` satisfies the predicate. */
async function waitForReply(channel: string, threadTs: string, afterTs: string, predicate: (m: ReplyMessage) => boolean, timeoutMs = 240_000): Promise<ReplyMessage> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const messages = await api.replies(channel, threadTs);
    const hit = messages.find((m) => m.bot_id && Number(m.ts) > Number(afterTs) && !m.text.startsWith("🧪") && predicate(m));
    if (hit) return hit;
    await sleep(2500);
  }
  throw new Error(`no matching reply in ${channel}/${threadTs} within ${timeoutMs / 1000}s`);
}

// The footer reads "<icon> _completed · 3s · model_"; Slack stores the icon as a :shortcode: in `text`.
const finished = (m: ReplyMessage) => /(completed|aborted|failed) · \d+(s|m)/.test(m.text);
const completed = (m: ReplyMessage) => /completed · \d+(s|m)/.test(m.text);
const hasTaskCard = (m: ReplyMessage) => (m.blocks ?? []).some((b: any) => b.type === "task_card");

const results: { name: string; ok: boolean; detail: string; seconds: number }[] = [];
async function scenario(name: string, fn: () => Promise<string>): Promise<void> {
  if (only && !only.has(name)) return;
  const started = Date.now();
  process.stdout.write(`▶ ${name} … `);
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail, seconds: (Date.now() - started) / 1000 });
    console.log(`ok (${detail})`);
  } catch (err) {
    results.push({ name, ok: false, detail: (err as Error).message, seconds: (Date.now() - started) / 1000 });
    console.log(`FAILED: ${(err as Error).message}`);
  }
}

function expect(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

const permalink = async (channel: string, ts: string) => (await client.chat.getPermalink({ channel, message_ts: ts })).permalink;
const links: string[] = [];

// 1. Channel chat with Claude Code: tool call + streamed answer, memory across turns, resume after release, !stop.
await scenario("claude-channel-chat", async () => {
  const root = await userSays(CHANNEL, "Remember the codeword PINEAPPLE-42. Use your shell tool to run `echo e2e-tool-ok`, then reply with exactly: READY");
  links.push(`claude chat: ${await permalink(CHANNEL, root)}`);
  const first = await waitForReply(CHANNEL, root, root, finished);
  expect(/READY/.test(first.text), `first answer lacks READY: ${first.text.slice(0, 200)}`);
  expect(hasTaskCard(first), "first answer has no tool task card");
  expect(completed(first), "first turn did not complete");

  const q = await userSays(CHANNEL, "What was the codeword? Reply with only the codeword.", root);
  const second = await waitForReply(CHANNEL, root, q, finished);
  expect(/PINEAPPLE-42/.test(second.text), `follow-up lost context: ${second.text.slice(0, 200)}`);

  const rel = await userSays(CHANNEL, "!release", root);
  await waitForReply(CHANNEL, root, rel, (m) => /released/.test(m.text), 30_000);
  expect(bridge.manager.get(CHANNEL, root) === undefined, "session still live after !release");
  const q2 = await userSays(CHANNEL, "Repeat the codeword once more, only the codeword.", root);
  const third = await waitForReply(CHANNEL, root, q2, finished);
  expect(/PINEAPPLE-42/.test(third.text), `resumed session lost context: ${third.text.slice(0, 200)}`);

  // Claude Code refuses a foreground `sleep`, so wait in python instead.
  const long = await userSays(CHANNEL, "Run this exact command with your shell tool in the foreground (not in the background): `python3 -c 'import time; time.sleep(120); print(\"late\")'`, then say done.", root);
  await waitForReply(CHANNEL, root, long, hasTaskCard, 120_000);
  await sleep(2000);
  expect(bridge.manager.get(CHANNEL, root)?.session.busy() === true, "the long turn was not running when !stop was sent");
  await userSays(CHANNEL, "!stop", root);
  const stopped = await waitForReply(CHANNEL, root, long, (m) => /aborted/.test(m.text), 90_000);
  expect(!/late/.test(stopped.text), "the stopped turn still finished the command");
  return "tool card, context kept, resumed after release, !stop aborted";
});

// 2. omp over ACP in the owner's DM: chat, follow-up, resume.
await scenario("omp-dm-chat", async () => {
  const root = await userSays(dm, "!chat --agent omp Remember the codeword MANGO-7. Reply with exactly: OK");
  links.push(`omp DM chat: ${await permalink(dm, root)}`);
  const first = await waitForReply(dm, root, root, finished);
  expect(/\bOK\b/.test(first.text) && completed(first), `unexpected first answer: ${first.text.slice(0, 200)}`);
  await bridge.manager.release(dm, root);
  const q = await userSays(dm, "What was the codeword? Reply with only the codeword.", root);
  const second = await waitForReply(dm, root, q, finished);
  expect(/MANGO-7/.test(second.text), `resumed omp session lost context: ${second.text.slice(0, 200)}`);
  return "answered, resumed via ACP after release";
});

// 3. One-shot task with omp in the channel.
await scenario("omp-oneshot", async () => {
  const root = await userSays(CHANNEL, "!run --agent omp Use your shell tool to run `echo oneshot-tool`, then reply with exactly: ONESHOT-OK");
  links.push(`omp one-shot: ${await permalink(CHANNEL, root)}`);
  const answer = await waitForReply(CHANNEL, root, root, finished);
  expect(/ONESHOT-OK/.test(answer.text), `one-shot answer: ${answer.text.slice(0, 200)}`);
  expect(hasTaskCard(answer), "one-shot answer has no tool task card");
  await Promise.all([...bridge.router.background]);
  expect(bridge.manager.get(CHANNEL, root) === undefined, "one-shot session still live");
  const run = bridge.store.db.prepare("SELECT outcome FROM runs WHERE thread_ts = ?").get(root) as { outcome: string } | undefined;
  expect(run?.outcome === "completed", `run row: ${JSON.stringify(run)}`);
  return "completed, process released, run recorded";
});

// 3b. Antigravity (agy acp through OAR): chat with a tool call, context, resume after release, one-shot.
await scenario("agy-channel-chat", async () => {
  const root = await userSays(CHANNEL, "!chat --agent agy Remember the codeword KIWI-9. Use your shell tool to run `echo agy-tool-ok`, then reply with exactly: READY");
  links.push(`agy chat: ${await permalink(CHANNEL, root)}`);
  const first = await waitForReply(CHANNEL, root, root, finished);
  expect(/READY/.test(first.text) && completed(first), `unexpected first answer: ${first.text.slice(0, 200)}`);
  expect(hasTaskCard(first), "first answer has no tool task card");
  const q = await userSays(CHANNEL, "What was the codeword? Reply with only the codeword.", root);
  const second = await waitForReply(CHANNEL, root, q, finished);
  expect(/KIWI-9/.test(second.text), `follow-up lost context: ${second.text.slice(0, 200)}`);
  await bridge.manager.release(CHANNEL, root);
  const q2 = await userSays(CHANNEL, "Repeat the codeword once more, only the codeword.", root);
  const third = await waitForReply(CHANNEL, root, q2, finished);
  expect(/KIWI-9/.test(third.text), `resumed agy session lost context: ${third.text.slice(0, 200)}`);

  const shot = await userSays(CHANNEL, "!run --agent agy Reply with exactly: AGY-ONESHOT-OK");
  links.push(`agy one-shot: ${await permalink(CHANNEL, shot)}`);
  const answer = await waitForReply(CHANNEL, shot, shot, finished);
  expect(/AGY-ONESHOT-OK/.test(answer.text) && completed(answer), `one-shot answer: ${answer.text.slice(0, 200)}`);
  await Promise.all([...bridge.router.background]);
  expect(bridge.manager.get(CHANNEL, shot) === undefined, "agy one-shot session still live");
  return "tool card, context kept, resumed after release, one-shot completed";
});

// 4. Scheduled task that fires on its own (every 30 s) into the owner's DM, with Claude Code.
await scenario("cron-dm-claude", async () => {
  const cmd = await userSays(CHANNEL, '!cron add "*/30 * * * * *" --channel dm Reply with exactly: CRON-OK');
  const ack = await waitForReply(CHANNEL, cmd, cmd, (m) => /schedule \*#\d+\*/.test(m.text) || /schedule #\d+/.test(m.text), 30_000);
  const id = Number(ack.text.match(/#(\d+)/)![1]);
  const deadline = Date.now() + 240_000;
  let header: string | undefined;
  while (!header && Date.now() < deadline) {
    const history = await client.conversations.history({ channel: dm, limit: 20 });
    // Earlier e2e runs also had a schedule #1 in this DM; only count headers posted after this add.
    header = history.messages?.find((m) => m.bot_id && Number(m.ts) > Number(cmd) && m.text?.includes(`· #${id} ·`))?.ts;
    if (!header) await sleep(3000);
  }
  expect(Boolean(header), `schedule #${id} never fired`);
  links.push(`cron in DM: ${await permalink(dm, header!)}`);
  const answer = await waitForReply(dm, header!, header!, finished);
  expect(/CRON-OK/.test(answer.text), `cron answer: ${answer.text.slice(0, 200)}`);
  const list = await userSays(CHANNEL, "!cron list", cmd);
  const listed = await waitForReply(CHANNEL, cmd, list, (m) => m.text.includes(`#${id}`), 30_000);
  expect(/last completed|running/.test(listed.text), `cron list: ${listed.text.slice(0, 200)}`);
  const rm = await userSays(CHANNEL, `!cron rm ${id}`, cmd);
  await waitForReply(CHANNEL, cmd, rm, (m) => /removed/.test(m.text), 30_000);
  // Let a firing that started before removal finish, so it doesn't outlive the test.
  while (bridge.scheduler.isRunning(id)) await sleep(1000);
  return `schedule #${id} fired by itself, answered, listed, removed`;
});

// 5. Continue-mode schedule with omp, triggered twice with !cron run: same thread, same session.
await scenario("cron-continue-omp", async () => {
  const cmd = await userSays(CHANNEL, '!cron add "0 0 1 1 *" --agent omp --mode continue Count how many times you have been asked this in this conversation; reply with exactly: TICK <n>');
  const ack = await waitForReply(CHANNEL, cmd, cmd, (m) => /#\d+/.test(m.text), 30_000);
  const id = Number(ack.text.match(/#(\d+)/)![1]);
  await bridge.scheduler.fire(id);
  await bridge.scheduler.fire(id);
  const row = bridge.store.getSchedule(id)!;
  expect(Boolean(row.thread_ts), "continue schedule has no thread");
  links.push(`cron continue: ${await permalink(CHANNEL, row.thread_ts!)}`);
  const replies = await api.replies(CHANNEL, row.thread_ts!);
  const answers = replies.filter((m) => m.bot_id && /TICK/.test(m.text) && finished(m));
  expect(answers.length === 2, `expected 2 answers in one thread, got ${answers.length}`);
  expect(/TICK 2/.test(answers[1]!.text), `second run did not see the first: ${answers[1]!.text.slice(0, 120)}`);
  bridge.scheduler.remove(id);
  return "two runs in one thread, second saw the first";
});

// 6. Exec and silent schedules (cc-connect parity), triggered with !cron run into the DM.
await scenario("cron-exec-silent", async () => {
  const add1 = await userSays(CHANNEL, '!cron add "0 0 1 1 *" --exec --name e2e-exec --channel dm echo e2e-exec-ok; echo to-stderr >&2');
  const ack1 = await waitForReply(CHANNEL, add1, add1, (m) => /#\d+/.test(m.text), 30_000);
  const execId = Number(ack1.text.match(/#(\d+)/)![1]);
  const add2 = await userSays(CHANNEL, '!cron add "0 0 1 1 *" --silent --name e2e-silent --channel dm Use your shell tool to run `echo silent-tool`, then reply with exactly: SILENT-OK');
  const ack2 = await waitForReply(CHANNEL, add2, add2, (m) => /#\d+/.test(m.text), 30_000);
  const silentId = Number(ack2.text.match(/#(\d+)/)![1]);
  const since = (await api.postMessage({ channel: dm, text: `🧪 _e2e ${runTag}: exec + silent schedules_` })).ts;
  await bridge.scheduler.fire(execId);
  await bridge.scheduler.fire(silentId);
  const history = (await client.conversations.history({ channel: dm, oldest: since, limit: 20 })).messages ?? [];
  const execMsg = history.find((m) => m.text?.includes("e2e-exec"));
  expect(Boolean(execMsg) && /✅|white_check_mark/.test(execMsg!.text!) && /e2e-exec-ok/.test(execMsg!.text!) && /to-stderr/.test(execMsg!.text!), `exec message: ${execMsg?.text}`);
  const silentMsgs = history.filter((m) => m.bot_id && Number(m.ts) > Number(since) && !m.text?.includes("e2e-exec"));
  expect(silentMsgs.length === 1 && silentMsgs[0]!.text?.trim() === "SILENT-OK", `silent run should post exactly the answer, got ${JSON.stringify(silentMsgs.map((m) => m.text))}`);
  links.push(`exec + silent in DM: ${await permalink(dm, since)}`);
  // The silent answer's thread continues the run's session.
  const q = await userSays(dm, "What exact text did you reply last time? Reply with only that text, lowercased.", silentMsgs[0]!.ts!);
  const follow = await waitForReply(dm, silentMsgs[0]!.ts!, q, finished);
  expect(/silent-ok/.test(follow.text), `silent session not resumed: ${follow.text.slice(0, 200)}`);
  bridge.scheduler.remove(execId);
  bridge.scheduler.remove(silentId);
  return "exec posted stdout+stderr, silent posted only the answer, its thread resumed";
});

// 7. Mentioned in a thread the bridge did not start: the agent reads the thread first.
await scenario("thread-context", async () => {
  const root = (await api.postMessage({ channel: CHANNEL, text: `🧪 _e2e ${runTag}:_ deploy of build 8812 failed with error code E-4711 on the canary` })).ts;
  await api.postMessage({ channel: CHANNEL, thread_ts: root, text: "🧪 rollback is done, the root cause is still open" });
  links.push(`thread context: ${await permalink(CHANNEL, root)}`);
  const ask = await userSays(CHANNEL, "Which error code was reported earlier in this thread? Reply with only the code.", root);
  const answer = await waitForReply(CHANNEL, root, ask, finished);
  expect(/E-4711/.test(answer.text), `answer without thread context: ${answer.text.slice(0, 200)}`);
  return "answered from the thread's earlier messages";
});

await bridge.shutdown();
const passed = results.filter((r) => r.ok).length;
const summary = [
  `🧪 *agent-bridge e2e ${runTag}*: ${passed}/${results.length} passed`,
  ...results.map((r) => `${r.ok ? "✅" : "❌"} ${r.name} (${r.seconds.toFixed(0)}s) — ${r.detail}`),
  ...links.map((l) => `• ${l}`),
].join("\n");
await api.postMessage({ channel: CHANNEL, text: summary });
console.log(`\n${summary}`);
process.exit(passed === results.length ? 0 : 1);
