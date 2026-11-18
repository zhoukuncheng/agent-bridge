import assert from "node:assert/strict";
import { test } from "node:test";
import { TurnRenderer } from "../src/slack/render.ts";
import { FakeSlack } from "./fakes.ts";

const target = { channel: "C1", threadTs: "100.1", recipientUserId: "U1", teamId: "T1" };

test("streams tool cards then text, closes with a footer", async () => {
  const slack = new FakeSlack();
  const r = new TurnRenderer(slack, target, { flushMs: 1 });
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
  const r = new TurnRenderer(slack, { channel: "D1", threadTs: "1.1" }, { flushMs: 1 });
  r.handle({ type: "text", text: "x" });
  await r.finish("completed");
  assert.equal((slack.calls[0] as { recipient_user_id?: string }).recipient_user_id, undefined);
});

test("long text rolls over into new streamed messages", async () => {
  const slack = new FakeSlack();
  const r = new TurnRenderer(slack, target, { flushMs: 1, rolloverChars: 10 });
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
  const r = new TurnRenderer(slack, target, { flushMs: 1 });
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
  const r = new TurnRenderer(slack, target, { flushMs: 1 });
  r.handle({ type: "tool_start", id: "a", name: "Bash", detail: "ls" });
  r.handle({ type: "text", text: "done" });
  await r.finish("failed", "exit 1");
  const last = slack.calls.filter((c) => c.method === "postMessage" || c.method === "update").at(-1) as { text: string };
  assert.match(last.text, /⏳ `Bash` ls/);
  assert.match(last.text, /done/);
  assert.match(last.text, /❌ failed/);
  assert.match(last.text, /> exit 1/);
});
