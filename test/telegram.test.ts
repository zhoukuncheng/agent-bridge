import assert from "node:assert/strict";
import test from "node:test";
import { route, type TelegramMessage } from "../src/telegram/route.ts";
const me = { id: 246, username: "agent_bot" };
const dm: TelegramMessage = { chat: { id: 123, type: "private" }, from: { id: 123 }, message_id: 3, text: "hello" };
const group = { ...dm, chat: { id: -150, type: "supergroup" }, message_thread_id: 101 };
const accept = (m: TelegramMessage) => route(m, "123", me);
test("owner DM, addressed group, reply and topic routing", () => {
  assert.equal(accept(dm)?.text, "hello");
  assert.equal(accept(group), undefined);
  assert.deepEqual(accept({ ...group, text: "/ask@agent_bot hi" })?.target, { chat_id: "-150", message_thread_id: 101 });
  assert.equal(accept({ ...group, text: "/ask@otherbot hi" }), undefined);
  assert.equal(accept({ ...group, reply_to_message: { from: { id: me.id } } })?.text, "hello");
});
test("ignore other humans, bots, channels and anonymous senders before dispatch", () => {
  for (const m of [dm, { ...group, text: "@agent_bot run" }]) {
    assert.equal(accept({ ...m, from: { id: 321 } }), undefined);
    assert.equal(accept({ ...m, from: { id: 123, is_bot: true } }), undefined);
    assert.equal(accept({ ...m, sender_chat: {} }), undefined);
    assert.equal(accept({ ...m, chat: { id: 123, type: "channel" } }), undefined);
  }
});
test("read nested Telegram rich message blocks", () => {
  assert.equal(accept({ ...dm, text: undefined, rich_message: { blocks: [{ type:"paragraph", text: [{type:"bold",text:"hello"}, " world"] }] } })?.text, "hello world");
});

import { defaultConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";
import { TelegramService } from "../src/telegram/service.ts";

test("a migrated silent exec posts its result and keeps the cron run history", async () => {
  const store = new Store(":memory:");
  const sent: string[] = [];
  const scheduler = new TelegramService(defaultConfig, store, {
    send: async (target, text) => {
      assert.equal(target.chat_id, "123");
      sent.push(text);
      return { message_id: 77 };
    },
  });
  try {
    const row = store.addSchedule({ agent: "codex", channel: "123", created_by: "123", cwd: "/tmp", mode: "fresh",
      exec: true, silent: true, cron: "0 0 * * *", timeout_min: 0, prompt: "printf cron-ok" });
    await scheduler.start();
    assert.ok(scheduler.nextRun(row.id));
    assert.ok(await scheduler.fire(row.id));
    assert.deepEqual(sent, ["cron-ok"]);
    assert.equal(store.lastRuns(row.id)[0].outcome, "completed");
  } finally {
    scheduler.stop();
    store.close();
  }
});
