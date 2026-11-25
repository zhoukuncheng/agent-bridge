import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { AcpDriver } from "./agents/acp.ts";
import { installOarWrappers, systemdRunAvailable } from "./agents/memcap.ts";
import { OarDriver } from "./agents/oar.ts";
import type { AgentDriver } from "./agents/types.ts";
import { expandHome, type Config } from "./config.ts";
import { Backfill } from "./core/backfill.ts";
import { SessionManager } from "./core/manager.ts";
import { Router } from "./core/router.ts";
import { Runner } from "./core/runner.ts";
import { Scheduler } from "./sched/scheduler.ts";
import { RedactingSlackApi, Redactor } from "./security/redact.ts";
import type { SlackApi } from "./slack/api.ts";
import type { RenderOptions } from "./slack/render.ts";
import { Store } from "./store.ts";

const oarBinaryVars: Record<string, [string, string]> = {
  claude: ["OAR_CLAUDE_BIN", "claude"],
  antigravity: ["OAR_ANTIGRAVITY_BIN", "agy"],
};

function executable(command: string, pathEnv: string): boolean {
  const candidates = command.includes("/") ? [command] : pathEnv.split(delimiter).filter(Boolean).map((dir) => join(dir, command));
  return candidates.some((path) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Startup warnings for agents whose CLI cannot be found, so the failure shows before the first message.
 * Covers ACP commands and Claude (needed for 🔒 sessions); OAR finds other runtimes in more places than PATH.
 */
export function agentWarnings(config: Config, env: NodeJS.ProcessEnv = process.env): string[] {
  const warnings: string[] = [];
  for (const [name, agent] of Object.entries(config.agents)) {
    let found: boolean;
    let command: string;
    if (agent.kind === "acp") {
      command = expandHome(agent.command);
      found = executable(command, env.PATH ?? "");
    } else if (agent.runtime === "claude") {
      command = env.OAR_CLAUDE_BIN || "claude";
      // OAR also looks where Claude Code's native installer puts it.
      found = executable(command, env.PATH ?? "") || (!env.OAR_CLAUDE_BIN && executable(join(env.HOME ?? "", ".local/bin/claude"), ""));
    } else continue;
    if (found) continue;
    warnings.push(
      name === config.restrictedAgent
        ? `agent "${name}": ${command} not found; 🔒 read-only sessions (guests, untrusted threads) will fail`
        : `agent "${name}": ${command} not found; sessions with it will fail`,
    );
  }
  return warnings;
}

/**
 * Builds the agent drivers. With `memoryCap`, every agent process starts in its own
 * systemd scope limited to `agentMemoryMax` (OAR runtimes through wrapper binaries).
 */
export function createDrivers(config: Config, opts: { memoryCap?: boolean; wrapperDir?: string } = {}): Record<string, AgentDriver> {
  let memoryMax: string | undefined;
  if (opts.memoryCap && config.agentMemoryMax) {
    if (systemdRunAvailable()) {
      memoryMax = config.agentMemoryMax;
      const wanted: Record<string, string> = {};
      for (const agent of Object.values(config.agents)) {
        const vars = agent.kind === "oar" ? oarBinaryVars[agent.runtime] : undefined;
        if (vars) wanted[vars[0]] = vars[1];
      }
      const installed = installOarWrappers(memoryMax, opts.wrapperDir ?? expandHome("~/.local/share/agent-bridge/bin"), wanted);
      console.log(`agent memory cap ${memoryMax} per process: ${installed.join(", ") || "no OAR wrappers"}`);
    } else {
      console.warn("systemd-run --user --scope is unavailable; agents run without a per-process memory cap");
    }
  }
  const drivers: Record<string, AgentDriver> = {};
  for (const [name, agent] of Object.entries(config.agents)) {
    if (agent.kind === "oar") drivers[name] = new OarDriver(name, { ...agent, secretPaths: config.secretPaths.map(expandHomeRule) });
    else drivers[name] = new AcpDriver(name, { ...agent, command: expandHome(agent.command), ...(memoryMax ? { memoryMax } : {}) });
  }
  return drivers;
}

/** Claude rules take `~/` literally; keep it, but expand anything else that starts with `~`. */
const expandHomeRule = (path: string) => (path.startsWith("~/") ? path : expandHome(path));

export interface Bridge {
  store: Store;
  api: SlackApi;
  manager: SessionManager;
  runner: Runner;
  scheduler: Scheduler;
  router: Router;
  backfill: Backfill;
  shutdown(): Promise<void>;
}

/** Wires the bridge's parts; transport (Socket Mode or a test harness) stays outside. */
export function createBridge(opts: {
  config: Config;
  api: SlackApi;
  botUserId: string;
  teamId?: string;
  drivers?: Record<string, AgentDriver>;
  store?: Store;
  renderOptions?: Partial<RenderOptions>;
  redactor?: Redactor;
  stallCheckMs?: number;
}): Bridge {
  const { config } = opts;
  // Everything the bridge posts goes through the redactor.
  const api = new RedactingSlackApi(opts.api, opts.redactor ?? Redactor.fromEnvironment());
  const store = opts.store ?? new Store(expandHome(config.dbPath));
  const drivers = opts.drivers ?? createDrivers(config);
  const manager = new SessionManager(drivers, store, api, {
    idleMinutes: config.idleMinutes,
    maxLiveSessions: config.maxLiveSessions,
    renderOptions: { display: config.display, ...opts.renderOptions },
    stall: { warnMinutes: config.stallMinutes, abortMinutes: config.stallAbortMinutes, ...(opts.stallCheckMs ? { checkMs: opts.stallCheckMs } : {}) },
  });
  const runner = new Runner(manager, store, api);
  const scheduler = new Scheduler(store, runner, manager, api, {
    runTimeoutMinutes: config.runTimeoutMinutes,
    teamId: opts.teamId,
    catchUp: config.cronCatchUp,
    catchUpHours: config.cronCatchUpHours,
  });
  const router = new Router({ config, store, api, manager, runner, scheduler, botUserId: opts.botUserId, teamId: opts.teamId });
  const backfill = new Backfill({ api, store, router, config, botUserId: opts.botUserId });
  return {
    store,
    api,
    manager,
    runner,
    scheduler,
    router,
    backfill,
    async shutdown() {
      scheduler.stop();
      await manager.shutdown();
      store.close();
    },
  };
}
