import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { agentWarnings } from "../src/bridge.ts";
import { defaultConfig, loadConfig } from "../src/config.ts";

function withConfig(body: object, check: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "agent-bridge-config-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify(body));
    check(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a configured agents map replaces the defaults", () => {
  withConfig({ ownerUserId: "U1", agents: { claude: { kind: "oar", runtime: "claude" } } }, (path) => {
    assert.deepEqual(Object.keys(loadConfig(path).agents), ["claude"]);
  });
  withConfig({ ownerUserId: "U1" }, (path) => {
    assert.deepEqual(Object.keys(loadConfig(path).agents), Object.keys(defaultConfig.agents));
  });
});

test("Slack configs must keep a Claude agent for read-only sessions; Telegram configs skip that check", () => {
  const codexOnly = { ownerUserId: "U1", defaultAgent: "codex", agents: { codex: { kind: "oar", runtime: "codex" } } };
  withConfig(codexOnly, (path) => assert.throws(() => loadConfig(path), /read-only sessions run on Claude Code/));
  withConfig({ ...codexOnly, ownerUserId: "123", telegram: { agent: "codex" } }, (path) => assert.equal(loadConfig(path).telegram?.agent, "codex"));
});

test("unknown top-level keys are reported", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  withConfig({ ownerUserId: "U1", idleMinute: 5, telegram: undefined }, (path) => loadConfig(path));
  assert.deepEqual(warn.mock.calls.map((c) => c.arguments[0]), ['config: unknown key "idleMinute" ignored']);
});

test("agentWarnings names missing ACP commands and a missing Claude for read-only sessions", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-bridge-bin-"));
  try {
    const omp = join(dir, "omp");
    writeFileSync(omp, "#!/bin/sh\n");
    chmodSync(omp, 0o755);
    const config = {
      ...defaultConfig,
      ownerUserId: "U1",
      agents: {
        claude: { kind: "oar" as const, runtime: "claude" },
        omp: { kind: "acp" as const, command: "omp", args: ["acp"] },
        gone: { kind: "acp" as const, command: "/nonexistent/agent", args: [] },
        codex: { kind: "oar" as const, runtime: "codex" },
      },
    };
    assert.deepEqual(agentWarnings(config, { PATH: dir, HOME: dir }), [
      'agent "claude": claude not found; 🔒 read-only sessions (guests, untrusted threads) will fail',
      'agent "gone": /nonexistent/agent not found; sessions with it will fail',
    ]);
    const claudeOnly = { ...config, agents: { claude: config.agents.claude } };
    // OAR_CLAUDE_BIN wins, and Claude Code's native installer location counts, as both do for OAR.
    assert.deepEqual(agentWarnings(claudeOnly, { PATH: "", HOME: dir, OAR_CLAUDE_BIN: omp }), []);
    mkdirSync(join(dir, ".local", "bin"), { recursive: true });
    writeFileSync(join(dir, ".local", "bin", "claude"), "#!/bin/sh\n", { mode: 0o755 });
    assert.deepEqual(agentWarnings(claudeOnly, { PATH: "", HOME: dir }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
