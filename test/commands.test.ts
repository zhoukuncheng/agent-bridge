import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeSlackText, parseCommand, stripMention } from "../src/core/commands.ts";

test("plain text is a chat prompt, kept verbatim", () => {
  assert.deepEqual(parseCommand("fix the flaky test\nin pkg/foo"), { kind: "chat", options: {}, prompt: "fix the flaky test\nin pkg/foo" });
});

test("!chat and !run take leading options, the rest is the prompt", () => {
  assert.deepEqual(parseCommand("!chat --agent omp --cwd ~/code/x  review --this flag"), {
    kind: "chat",
    options: { agent: "omp", cwd: "~/code/x" },
    prompt: "review --this flag",
  });
  assert.deepEqual(parseCommand("!run --timeout 5 --model haiku say hi"), { kind: "run", options: { timeoutMinutes: 5, model: "haiku" }, prompt: "say hi" });
  assert.equal(parseCommand("!run --timeout zero x").kind, "error");
  assert.equal(parseCommand("!run --bogus 1 x").kind, "error");
  assert.equal(parseCommand("!run").kind, "error");
});

test("!cron add takes a quoted expression (straight or smart quotes after decoding)", () => {
  const parsed = parseCommand(decodeSlackText('!cron add “0 9 * * 1-5” --agent omp --channel dm --mode continue --tz Asia/Shanghai daily report'));
  assert.deepEqual(parsed, {
    kind: "cron_add",
    options: { expr: "0 9 * * 1-5", agent: "omp", channel: "dm", mode: "continue", tz: "Asia/Shanghai", name: undefined, silent: false, exec: false },
    prompt: "daily report",
  });
  const flags = parseCommand('!cron add "0 9 * * *" --silent --name "PR review" --exec --timeout 10 ./run.sh --flag');
  assert.deepEqual(flags, {
    kind: "cron_add",
    options: { expr: "0 9 * * *", timeoutMinutes: 10, channel: undefined, mode: undefined, tz: undefined, name: "PR review", silent: true, exec: true },
    prompt: "./run.sh --flag",
  });
  assert.equal(parseCommand('!cron add "* * * * *" --mode weekly x').kind, "error");
  assert.equal(parseCommand('!cron add "* * * * *"').kind, "error");
});

test("!cron management subcommands", () => {
  assert.deepEqual(parseCommand("!cron"), { kind: "cron_list" });
  assert.deepEqual(parseCommand("!cron list"), { kind: "cron_list" });
  assert.deepEqual(parseCommand("!cron rm #3"), { kind: "cron_rm", id: 3 });
  assert.deepEqual(parseCommand("!cron run 7"), { kind: "cron_run", id: 7 });
  assert.equal(parseCommand("!cron pause x").kind, "error");
  assert.equal(parseCommand("!cron frobnicate 1").kind, "error");
});

test("thread controls and unknown commands", () => {
  assert.deepEqual(parseCommand("!stop"), { kind: "stop" });
  assert.deepEqual(parseCommand("!STATUS"), { kind: "status" });
  assert.equal(parseCommand("!nope").kind, "error");
});

test("Slack text decoding and mention stripping", () => {
  assert.equal(stripMention("<@U0BOT> hello <@U0BOT|bridge-bot>", "U0BOT"), "hello");
  assert.equal(decodeSlackText("a &lt;b&gt; &amp; <https://x.dev/a|x.dev/a> <https://y.dev> <#C123|general>"), "a <b> & x.dev/a (https://x.dev/a) https://y.dev <#C123>");
});
