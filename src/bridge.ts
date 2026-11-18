import { AcpDriver } from "./agents/acp.ts";
import { OarDriver } from "./agents/oar.ts";
import type { AgentDriver } from "./agents/types.ts";
import { expandHome, type Config } from "./config.ts";
import { SessionManager } from "./core/manager.ts";
import { Router } from "./core/router.ts";
import { Runner } from "./core/runner.ts";
import { Scheduler } from "./sched/scheduler.ts";
import type { SlackApi } from "./slack/api.ts";
import type { RenderOptions } from "./slack/render.ts";
import { Store } from "./store.ts";

export function createDrivers(config: Config): Record<string, AgentDriver> {
  const drivers: Record<string, AgentDriver> = {};
  for (const [name, agent] of Object.entries(config.agents)) {
    if (agent.kind === "oar") drivers[name] = new OarDriver(name, agent);
    else drivers[name] = new AcpDriver(name, { ...agent, command: expandHome(agent.command) });
  }
  return drivers;
}

export interface Bridge {
  store: Store;
  manager: SessionManager;
  runner: Runner;
  scheduler: Scheduler;
  router: Router;
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
}): Bridge {
  const { config, api } = opts;
  const store = opts.store ?? new Store(expandHome(config.dbPath));
  const drivers = opts.drivers ?? createDrivers(config);
  const manager = new SessionManager(drivers, store, api, {
    idleMinutes: config.idleMinutes,
    maxLiveSessions: config.maxLiveSessions,
    renderOptions: opts.renderOptions,
  });
  const runner = new Runner(manager, store, api);
  const scheduler = new Scheduler(store, runner, manager, api, { runTimeoutMinutes: config.runTimeoutMinutes, teamId: opts.teamId });
  const router = new Router({ config, store, api, manager, runner, scheduler, botUserId: opts.botUserId, teamId: opts.teamId });
  return {
    store,
    manager,
    runner,
    scheduler,
    router,
    async shutdown() {
      scheduler.stop();
      await manager.shutdown();
      store.close();
    },
  };
}
