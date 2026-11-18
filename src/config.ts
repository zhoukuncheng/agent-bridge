import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AcpAgentConfig } from "./agents/acp.ts";
import type { OarAgentConfig } from "./agents/oar.ts";

export type AgentConfig = ({ kind: "oar" } & OarAgentConfig) | ({ kind: "acp" } & AcpAgentConfig);

export interface Config {
  /** Slack user who owns the bridge; `--channel dm` and DMs resolve to this user. */
  ownerUserId: string;
  /** Only these Slack users can drive agents. Messages from anyone else are ignored. */
  allowUsers: string[];
  /** Channels the bridge answers in (DMs with allowed users always work). Empty: any channel the bot is in. */
  allowChannels: string[];
  defaultAgent: string;
  defaultCwd: string;
  /** Per-channel working directory overrides. */
  channelCwd: Record<string, string>;
  agents: Record<string, AgentConfig>;
  /** Live sessions idle this long are disposed; the next message resumes them. */
  idleMinutes: number;
  maxLiveSessions: number;
  /** One-shot and scheduled runs are aborted after this long. */
  runTimeoutMinutes: number;
  dbPath: string;
}

export function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export const defaultConfig: Config = {
  ownerUserId: "",
  allowUsers: [],
  allowChannels: [],
  defaultAgent: "claude",
  defaultCwd: "~",
  channelCwd: {},
  agents: {
    claude: { kind: "oar", runtime: "claude" },
    omp: { kind: "acp", command: "omp", args: ["acp"] },
  },
  idleMinutes: 30,
  maxLiveSessions: 4,
  runTimeoutMinutes: 60,
  dbPath: "~/.local/share/agent-bridge/bridge.db",
};

export function loadConfig(path = process.env.AGENT_BRIDGE_CONFIG ?? "~/.config/agent-bridge/config.json"): Config {
  const raw = JSON.parse(readFileSync(expandHome(path), "utf8")) as Partial<Config>;
  const config: Config = { ...defaultConfig, ...raw, agents: { ...defaultConfig.agents, ...raw.agents } };
  if (!config.ownerUserId) throw new Error("config: ownerUserId is required");
  if (!config.allowUsers.length) config.allowUsers = [config.ownerUserId];
  if (!config.agents[config.defaultAgent]) throw new Error(`config: defaultAgent ${config.defaultAgent} is not in agents`);
  return config;
}
