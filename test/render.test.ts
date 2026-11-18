import assert from "node:assert/strict";
import { test } from "node:test";
import { TurnRenderer } from "../src/slack/render.ts";
import { FakeSlack } from "./fakes.ts";

const target = { channel: "C1", threadTs: "100.1", recipientUserId: "U1", teamId: "T1" };

test("streams tool cards then text, closes with a footer", async () => {
  const slack = new FakeSlack();
  const r = new TurnRenderer(slack, target, { display: "verbose", flushMs: 1 });
  r.handle({ type: "model", model: "m1" });
  r.handle({ type: "tool_start", id: "call|long-id", name: "Bash" });
  r.handle({ type: "tool_input", id: "call|long-id", detail: "go test ./..." });
  r.handle({ type: "tool_end", id: "call|long-id", ok: false, output: "FAIL pkg" });
  r.handle({ type: "text", text: "Hello " });
  r.handle({ type: "text", text: "world" });
  await r.finish("completed");

  const start = slack.calls[0]!;
  assert.equal(start.method, "startStream");
  assert.equal((start as { recipient_user_id?: string }).recipient_user_id, "U1");
  const appends = slack.calls.filter((c) => c.method === "appendStream").flatMap((c) => (c as { chunks: any[] }).chunks);
  const tasks = appends.filter((c) => c.type === "task_update");
  assert.deepEqual(
    tasks.map((t) => [t.id, t.status, t.details ?? null, t.output ?? null]),
    [
      // Slack calls run on a chain, so the first card already carries the input that arrived meanwhile.
      ["t1", "in_progress", "go test ./...", null],
      ["t1", "in_progress", "go test ./...", null],
      ["t1", "error", "go test ./...", "FAIL pkg"],
    ],
  );
  const text = appends.filter((c) => c.type === "markdown_text").map((c) => c.text).join("");
  assert.match(text, /^Hello world\n\n_✅ completed · \d+s · m1_$/);
  assert.equal(slack.calls.at(-1)!.method, "stopStream");
  assert.equal(slack.calls.filter((c) => c.method === "startStream").length, 1);
});

test("a DM target omits the recipient", async () => {
  const slack = new FakeSlack();
  const r = new TurnRenderer(slack, { channel: "D1", threadTs: "1.1" }, { display: "verbose", flushMs: 1 });
  r.handle({ type: "text", text: "x" });
  await r.finish("completed");
  assert.equal((slack.calls[0] as { recipient_user_id?: string }).recipient_user_id, undefined);
});

test("long text rolls over into new streamed messages", async () => {
  const slack = new FakeSlack();
  const r = new TurnRenderer(slack, target, { display: "verbose", flushMs: 1, rolloverChars: 10 });
  r.handle({ type: "text", text: "0123456789abcdefghij" });
  await r.finish("completed");
  const starts = slack.calls.filter((c) => c.method === "startStream").length;
  assert.ok(starts >= 3, `expected at least 3 messages, got ${starts}`);
  assert.equal(slack.calls.filter((c) => c.method === "stopStream").length, starts);
  for (const c of slack.calls) if (c.method === "appendStream") for (const chunk of c.chunks) if (chunk.type === "markdown_text") assert.ok(chunk.text.length <= 10);
  assert.match(slack.textIn("100.1"), /^0123456789abcdefghij/);
});

test("a dead stream is replaced and the chunk resent", async () => {
  const slack = new FakeSlack();
  const r = new TurnRenderer(slack, target, { display: "verbose", flushMs: 1 });
  r.handle({ type: "tool_start", id: "a", name: "Read" });
  await new Promise((res) => setTimeout(res, 5));
  slack.failAppendOnce = true;
  r.handle({ type: "tool_end", id: "a", ok: true });
  await r.finish("completed");
  const starts = slack.calls.filter((c) => c.method === "startStream");
  assert.equal(starts.length, 2);
  const lastTask = slack.calls.filter((c) => c.method === "appendStream").flatMap((c) => (c as { chunks: any[] }).chunks).filter((c) => c.type === "task_update").at(-1);
  assert.equal(lastTask.status, "complete");
  assert.equal(lastTask.id, "t2");
});

test("falls back to post + update when streaming is unavailable", async () => {
  const slack = new FakeSlack();
  slack.failStart = true;
  const r = new TurnRenderer(slack, target, { display: "verbose", flushMs: 1 });
  r.handle({ type: "tool_start", id: "a", name: "Bash", detail: "ls" });
  r.handle({ type: "text", text: "done" });
  await r.finish("failed", "exit 1");
  const last = slack.calls.filter((c) => c.method === "postMessage" || c.method === "update").at(-1) as { text: string };
  assert.match(last.text, /⏳ `Bash` ls/);
  assert.match(last.text, /done/);
  assert.match(last.text, /❌ failed/);
  assert.match(last.text, /> exit 1/);
});

const allChunks = (slack: FakeSlack) => slack.calls.filter((c) => c.method === "appendStream").flatMap((c) => (c as { chunks: any[] }).chunks);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("concise: narration and tool calls fold into one card; only the answer streams", async () => {
  const slack = new FakeSlack();
  const r = new TurnRenderer(slack, target, { display: "concise", flushMs: 1, holdMs: 30, cardMs: 1 });
  r.handle({ type: "text", text: "Let me check the tests first." });
  r.handle({ type: "tool_start", id: "a", name: "Bash", detail: "go test ./..." });
  r.handle({ type: "tool_end", id: "a", ok: true });
  r.handle({ type: "text", text: "Now the config.\n" });
  r.handle({ type: "tool_start", id: "b", name: "Read", detail: "config.ts" });
  r.handle({ type: "tool_end", id: "b", ok: false });
  r.handle({ type: "tool_start", id: "c", name: "Bash", detail: "ls" });
  r.handle({ type: "tool_end", id: "c", ok: true });
  await sleep(10);
  r.handle({ type: "text", text: "All good: " });
  r.handle({ type: "text", text: "the tests pass." });
  await r.finish("completed");

  const chunks = allChunks(slack);
  const cards = chunks.filter((c) => c.type === "task_update");
  assert.ok(cards.length >= 2);
  assert.ok(cards.every((c) => c.id === "t1"), "all updates go to one card");
  assert.ok(cards.some((c) => c.title === "Now the config."), "narration becomes the card title");
  const last = cards.at(-1);
  assert.equal(last.status, "complete");
  assert.equal(last.title, "3 steps · Bash ×2, Read");
  assert.match(last.details, /^✓ Bash  go test \.\/\.\.\.\n✗ Read  config\.ts\n✓ Bash  ls$/);
  const text = chunks.filter((c) => c.type === "markdown_text").map((c) => c.text).join("");
  assert.match(text, /^All good: the tests pass\.\n\n_✅ completed/);
  assert.doesNotMatch(text, /Let me check|Now the config/);
});

test("concise: text with no tool call after it is the answer and streams after the hold", async () => {
  const slack = new FakeSlack();
  const r = new TurnRenderer(slack, target, { display: "concise", flushMs: 1, holdMs: 20, cardMs: 1 });
  r.handle({ type: "text", text: "Here is the answer. " });
  await sleep(60);
  assert.match(slack.textIn("100.1"), /Here is the answer/, "streamed before the turn ended");
  r.handle({ type: "text", text: "More." });
  await r.finish("completed");
  assert.equal(allChunks(slack).filter((c) => c.type === "task_update").length, 0);
  assert.match(slack.textIn("100.1"), /^Here is the answer\. More\./);
});

test("concise: a long held text is promoted without waiting", async () => {
  const slack = new FakeSlack();
  const r = new TurnRenderer(slack, target, { display: "concise", flushMs: 1, holdMs: 60_000, holdChars: 50 });
  r.handle({ type: "text", text: "x ".repeat(40) });
  await sleep(20);
  assert.ok(slack.textIn("100.1").length > 0);
  await r.finish("completed");
});

test("text is flushed at whitespace so a token is never split across appends", async () => {
  const slack = new FakeSlack();
  const r = new TurnRenderer(slack, target, { display: "verbose", flushMs: 5 });
  r.handle({ type: "text", text: "token: xoxb-1234" });
  await sleep(30);
  r.handle({ type: "text", text: "567890abcdef done" });
  await r.finish("completed");
  const pieces = allChunks(slack).filter((c) => c.type === "markdown_text").map((c) => c.text);
  assert.ok(pieces.some((p) => p.includes("xoxb-1234567890abcdef")), `token split across appends: ${JSON.stringify(pieces)}`);
});
