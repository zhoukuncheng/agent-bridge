import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig, type Config } from "../src/config.ts";
import { Store } from "../src/store.ts";
import type { Target } from "../src/telegram/api.ts";
import { cronCommand } from "../src/telegram/cron.ts";
import { TelegramService } from "../src/telegram/service.ts";

const config: Config = { ...defaultConfig, ownerUserId: "123", defaultCwd: "/tmp", telegram: { agent: "codex" } };

function setup() {
  const store = new Store(":memory:");
  const posted: { target: Target; text: string }[] = [];
  const scheduler = new TelegramService(config, store, {
    send: async (target, text) => {
      posted.push({ target, text });
      return { message_id: posted.length };
    },
  });
  const replies: string[] = [];
  const ctx = (target: Target) => ({ config, store, scheduler, target, send: async (text: string) => void replies.push(text) });
  return { store, scheduler, posted, replies, ctx };
}

test("/cron add creates a schedule for this chat and topic, and list/pause/resume/rm manage it", async () => {
  const { store, scheduler, ctx } = setup();
  try {
    const topic = ctx({ chat_id: "-150", message_thread_id: 7 });
    const added = await cronCommand('add “0 9 * * 1-5” --name standup --tz Asia/Shanghai --silent summarize the board', topic);
    assert.match(added, /^Added schedule #1 standup · 0 9 \* \* 1-5 \(Asia\/Shanghai\) · silent\nNext run: \d{4}-/);
    const row = store.getSchedule(1)!;
    assert.equal(row.channel, "-150");
    assert.equal(row.thread_ts, "7");
    assert.equal(row.created_by, "123");
    assert.equal(row.cwd, "/tmp");
    assert.equal(row.prompt, "summarize the board");
    assert.match(await cronCommand("list", topic), /#1 standup · 0 9 \* \* 1-5 \(Asia\/Shanghai\) · silent · next \d{4}-/);
    assert.equal(await cronCommand("pause 1", topic), "Schedule #1 paused.");
    assert.equal(scheduler.nextRun(1), null);
    assert.match(await cronCommand("list", topic), /· paused/);
    assert.equal(await cronCommand("resume #1", topic), "Schedule #1 resumed.");
    assert.ok(scheduler.nextRun(1));
    assert.equal(await cronCommand("rm 1", topic), "Removed schedule #1.");
    assert.equal(await cronCommand("rm 1", topic), "No schedule #1.");
    assert.match(await cronCommand("list", topic), /No schedules\./);
  } finally {
    scheduler.stop();
    store.close();
  }
});

test("/cron add rejects Slack-only options, bad expressions and missing prompts without saving anything", async () => {
  const { store, scheduler, ctx } = setup();
  try {
    const dm = ctx({ chat_id: "123" });
    assert.match(await cronCommand('add "0 9 * * *" --agent claude hi', dm), /not available on Telegram/);
    assert.match(await cronCommand('add "0 9 * * *" --channel dm hi', dm), /not available on Telegram/);
    assert.match(await cronCommand('add "not a cron" hi', dm), /^Invalid schedule:/);
    assert.match(await cronCommand('add "0 9 * * *"', dm), /^\/cron add needs a prompt/);
    assert.match(await cronCommand("bogus", dm), /unknown \/cron subcommand "bogus"[\s\S]*\/cron add/);
    assert.equal(store.listSchedules().length, 0);
  } finally {
    scheduler.stop();
    store.close();
  }
});

test("/cron run fires an exec schedule into the topic it was added from", async () => {
  const { store, scheduler, posted, replies, ctx } = setup();
  try {
    const topic = ctx({ chat_id: "-150", message_thread_id: 7 });
    await cronCommand('add "0 0 1 1 *" --exec printf ok', topic);
    assert.equal(await cronCommand("run 1", topic), "Running schedule #1 now.");
    for (let i = 0; i < 100 && !posted.length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(posted, [{ target: { chat_id: "-150", message_thread_id: 7 }, text: "ok" }]);
    assert.equal(await cronCommand("run 9", topic), "No schedule #9.");
    assert.deepEqual(replies, []);
  } finally {
    scheduler.stop();
    store.close();
  }
});
