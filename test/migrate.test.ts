import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.ts";

const script = fileURLToPath(new URL("../scripts/migrate-cc-connect.ts", import.meta.url));

test("imports cc-connect cron jobs once, keeping kind, schedule, target and state", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-migrate-"));
  const jobs = [
    { id: "a1", session_key: "slack:D0DM:U0ME", cron_expr: "0 23 * * *", prompt: "sync", description: "Daily sync", enabled: true, session_mode: "new_per_run" },
    { id: "b2", session_key: "slack:D0DM:U0ME", cron_expr: "30 7,13 * * *", prompt: "review", description: "Review", enabled: true, silent: true, session_mode: "new_per_run", timeout_mins: 30 },
    { id: "c3", session_key: "slack:D0DM:U0ME", cron_expr: "0 11 * * 1", exec: "/bin/report.sh --weekly", description: "Weekly", enabled: true, timeout_mins: 60 },
    { id: "d4", session_key: "slack:C0CH:U0ME", cron_expr: "0 0 */2 * *", prompt: "old", enabled: false },
    { id: "e5", session_key: "lark:x:y", cron_expr: "* * * * *", prompt: "elsewhere", enabled: true },
  ];
  writeFileSync(join(dir, "jobs.json"), JSON.stringify(jobs));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ ownerUserId: "U0ME", dbPath: join(dir, "bridge.db") }));
  const run = () =>
    execFileSync(process.execPath, [script, "--jobs", join(dir, "jobs.json"), "--cwd", dir], { env: { ...process.env, AGENT_BRIDGE_CONFIG: join(dir, "config.json") }, encoding: "utf8" });
  assert.match(run(), /imported 4 of 5 jobs/);
  assert.match(run(), /imported 0 of 5 jobs/);

  const store = new Store(join(dir, "bridge.db"));
  const rows = store.listSchedules();
  store.close();
  assert.deepEqual(
    rows.map((r) => [r.origin, r.name, r.cron, r.channel, r.created_by, r.exec, r.silent, r.mode, r.enabled, r.timeout_min, r.prompt]),
    [
      ["cc-connect:a1", "Daily sync", "0 23 * * *", "D0DM", "U0ME", 0, 0, "fresh", 1, 30, "sync"],
      ["cc-connect:b2", "Review", "30 7,13 * * *", "D0DM", "U0ME", 0, 1, "fresh", 1, 30, "review"],
      ["cc-connect:c3", "Weekly", "0 11 * * 1", "D0DM", "U0ME", 1, 0, "fresh", 1, 60, "/bin/report.sh --weekly"],
      ["cc-connect:d4", null, "0 0 */2 * *", "C0CH", "U0ME", 0, 0, "continue", 0, 30, "old"],
    ],
  );
});

test("rejects a foreign Telegram DM without committing earlier jobs", () => {
  const dir = mkdtempSync(join(tmpdir(), "telegram-migrate-"));
  const config = join(dir, "config.json"), db = join(dir, "bridge.db");
  writeFileSync(config, JSON.stringify({ ownerUserId: "123", dbPath: db }));
  const jobs = ["telegram:123:123", "telegram:456:123"].map((session_key, i) => ({
    session_key, id: String(i), cron_expr: "0 0 * * *", prompt: "report", enabled: true,
  }));
  const path = join(dir, "jobs.json");
  writeFileSync(path, JSON.stringify(jobs));
  assert.throws(() => execFileSync(process.execPath, [script, "--platform", "telegram", "--jobs", path], {
    env: { ...process.env, AGENT_BRIDGE_CONFIG: config }, stdio: "pipe",
  }), /unexpected Telegram target/);
  const store = new Store(db);
  assert.deepEqual(store.listSchedules(), []);
  store.close();
});
