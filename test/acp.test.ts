import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { AcpDriver } from "../src/agents/acp.ts";
import type { AgentEvent, AgentSession } from "../src/agents/types.ts";

const fixture = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const driver = (args: string[] = []) => new AcpDriver("fake", { command: process.execPath, args: [fixture, ...args] });

function collect(session: AgentSession): AgentEvent[] {
  const events: AgentEvent[] = [];
  session.onEvent((e) => events.push(e));
  return events;
}

function turnEnd(session: AgentSession): Promise<AgentEvent> {
  return new Promise((resolve) => {
    const off = session.onEvent((e) => {
      if (e.type === "turn_end") {
        off();
        resolve(e);
      }
    });
  });
}

test("a prompt streams text, tool calls (auto-approved) and usage, then ends", async () => {
  const session = await driver().open({ cwd: tmpdir() });
  const events = collect(session);
  const ended = turnEnd(session);
  assert.equal(await session.send("TOOL please"), "prompted");
  assert.equal(session.busy(), true);
  assert.deepEqual(await ended, { type: "turn_end", outcome: "completed" });
  assert.equal(session.busy(), false);
  const text = events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
  assert.equal(text, "echo: TOOL please");
  assert.deepEqual(events.find((e) => e.type === "tool_start"), { type: "tool_start", id: "tc1", name: "$ echo hi", detail: "echo hi" });
  assert.deepEqual(events.find((e) => e.type === "tool_end"), { type: "tool_end", id: "tc1", ok: true, output: "hi (ok)" });
  assert.ok(events.some((e) => e.type === "usage" && e.costUsd === 0.01 && e.contextSize === 100));
  await session.dispose();
});

test("input sent while busy is queued, merged and run after the turn; abort cancels", async () => {
  const session = await driver().open({ cwd: tmpdir() });
  const events = collect(session);
  const first = turnEnd(session);
  await session.send("HANG");
  assert.equal(await session.send("second"), "queued");
  assert.equal(await session.send("third"), "queued");
  await session.abort();
  assert.deepEqual(await first, { type: "turn_end", outcome: "aborted" });
  // abort also drops the queue, so nothing else runs.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(events.filter((e) => e.type === "turn_start").length, 1);

  const busy = turnEnd(session);
  await session.send("HANG again");
  await session.send("next");
  const queuedTurn = new Promise<void>((resolve) => {
    let ends = 0;
    session.onEvent((e) => {
      if (e.type === "turn_end" && ++ends === 2) resolve();
    });
  });
  // Cancel the hanging turn without abort() to keep the queue, as a native cancel would.
  (session as any).conn.notify("session/cancel", { sessionId: session.id });
  await busy;
  await queuedTurn;
  const text = events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
  assert.equal(text, "echo: next");
  await session.dispose();
});

test("resume uses session/resume when offered, session/load (without replaying history) otherwise", async () => {
  const resumed = await driver().open({ cwd: tmpdir(), resume: "abc" });
  assert.equal(resumed.id, "abc");
  await resumed.dispose();

  const loaded = await driver(["--load-only"]).open({ cwd: tmpdir(), resume: "xyz" });
  const events = collect(loaded);
  const ended = turnEnd(loaded);
  await loaded.send("hi");
  await ended;
  const text = events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
  assert.equal(text, "echo: hi");
  await loaded.dispose();
});

test("a rejected model fails the open and kills the process", async () => {
  await assert.rejects(driver().open({ cwd: tmpdir(), model: "bad-model" }), /unknown model/);
});

test("process exit fails the running turn and reports exited", async () => {
  const session = await driver().open({ cwd: tmpdir() });
  const events = collect(session);
  const ended = turnEnd(session);
  await session.send("HANG");
  (session as any).conn.kill();
  assert.equal(((await ended) as { outcome: string }).outcome, "failed");
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(events.some((e) => e.type === "exited"));
});
