// Imports cc-connect cron jobs into agent-bridge's schedule table.
//
//   node scripts/migrate-cc-connect.ts [--jobs ~/.cc-connect/crons/jobs.json] [--cwd ~/code] [--agent claude] [--dry-run]
//
// Mapping: session_key "slack:<channel>:<user>" → channel and owner; description → name;
// exec → exec schedule; silent → silent; session_mode new_per_run → fresh, reuse (the default)
// → continue; timeout_mins kept (cc-connect's default was 30); enabled kept (disabled
// jobs come over paused). Re-running skips jobs already imported (origin cc-connect:<id>).
// Run it while agent-bridge is stopped: the daemon loads schedules at start.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { expandHome, loadConfig } from "../src/config.ts";
import { Scheduler } from "../src/sched/scheduler.ts";
import { Store } from "../src/store.ts";

interface CcJob {
  id: string;
  session_key: string;
  cron_expr: string;
  prompt?: string;
  exec?: string;
  description?: string;
  enabled: boolean;
  silent?: boolean;
  mute?: boolean;
  session_mode?: string;
  timeout_mins?: number;
}

const { values } = parseArgs({
  options: {
    jobs: { type: "string", default: "~/.cc-connect/crons/jobs.json" },
    cwd: { type: "string", default: "~/code" },
    agent: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});
const config = loadConfig();
const agent = values.agent ?? config.defaultAgent;
const cwd = expandHome(values.cwd!);
const jobs = JSON.parse(readFileSync(expandHome(values.jobs!), "utf8")) as CcJob[];
const store = new Store(expandHome(config.dbPath));

let imported = 0;
for (const job of jobs) {
  const origin = `cc-connect:${job.id}`;
  const [platform, channel, user] = job.session_key.split(":");
  const label = `${job.id} ${job.description ?? ""}`;
  if (platform !== "slack" || !channel || !user) {
    console.log(`skip ${label}: session ${job.session_key} is not a Slack session`);
    continue;
  }
  if (store.findScheduleByOrigin(origin)) {
    console.log(`skip ${label}: already imported`);
    continue;
  }
  if (job.mute) console.log(`note ${label}: muted in cc-connect; imported as silent`);
  Scheduler.validate(job.cron_expr);
  const row = {
    name: job.description || null,
    cron: job.cron_expr,
    channel,
    agent,
    cwd,
    prompt: job.exec || job.prompt || "",
    exec: Boolean(job.exec),
    silent: Boolean(job.silent || job.mute),
    timeout_min: job.timeout_mins ?? 30,
    origin,
    // cc-connect defaulted to reusing the session.
    mode: job.session_mode === "new_per_run" || job.exec ? ("fresh" as const) : ("continue" as const),
    enabled: job.enabled,
    created_by: user,
  };
  if (values["dry-run"]) {
    console.log(`would import ${label}: ${JSON.stringify({ ...row, prompt: row.prompt.slice(0, 60) })}`);
  } else {
    const added = store.addSchedule(row);
    console.log(`imported ${label} → #${added.id} (${row.exec ? "exec" : row.silent ? "silent" : row.mode}, ${row.enabled ? "enabled" : "paused"})`);
  }
  imported++;
}
store.close();
console.log(`${values["dry-run"] ? "would import" : "imported"} ${imported} of ${jobs.length} jobs`);
