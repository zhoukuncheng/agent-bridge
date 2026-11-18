import assert from "node:assert/strict";
import { test } from "node:test";
import { toInbound } from "../src/slack/app.ts";

test("user messages and mentions map to router input", () => {
  assert.deepEqual(toInbound({ type: "message", channel: "C1", channel_type: "channel", user: "U1", text: "hi", ts: "1.2", thread_ts: "1.1", team: "T1" }), {
    channel: "C1",
    channelType: "channel",
    user: "U1",
    text: "hi",
    ts: "1.2",
    threadTs: "1.1",
    teamId: "T1",
  });
  // app_mention carries no channel_type; DMs are recognised by their D prefix.
  assert.equal(toInbound({ type: "app_mention", channel: "D9", user: "U1", text: "x", ts: "1" }, "T1")!.channelType, "im");
  assert.equal(toInbound({ type: "message", channel: "C1", user: "U1", text: "x", ts: "1", subtype: "file_share" })!.text, "x");
});

test("bot messages, edits and other subtypes are ignored", () => {
  assert.equal(toInbound({ channel: "C1", user: "U1", text: "x", ts: "1", bot_id: "B1" }), undefined);
  assert.equal(toInbound({ channel: "C1", text: "x", ts: "1", subtype: "message_changed" }), undefined);
  assert.equal(toInbound({ channel: "C1", user: "U1", text: "x", ts: "1", subtype: "channel_join" }), undefined);
});
