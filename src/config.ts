import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AcpAgentConfig } from "./agents/acp.ts";
import type { OarAgentConfig } from "./agents/oar.ts";

export type AgentConfig = ({ kind: "oar" } & OarAgentConfig) | ({ kind: "acp" } & AcpAgentConfig);

export interface Config {
  telegram?: {
    agent?: "codex" | "agy" | "antigravity";
    model?: string;
    effort?: string;
    fullAccess?: boolean;
    providers?: Partial<Record<"codex" | "antigravity", { model?: string; effort?: string }>>;
  };
  /** Slack user who owns the bridge; `--channel dm` and DMs resolve to this user. */
  ownerUserId: string;
  /** Users with full access. Defaults to the owner. */
  allowUsers: string[];
  /**
   * true (default): only allowUsers can talk to or mention the bot; anyone else is ignored.
   * false: anyone who can see the bot can mention or DM it, but their sessions are restricted
   * (read-only tools, no user config) and they cannot run commands other than !help and !stop.
   */
  ownerOnly: boolean;
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
  /** concise (default): tool calls and narration fold into one progress card; verbose: one card per tool call. */
  display: "concise" | "verbose";
  /** Warn in the thread when a running turn has produced nothing for this long. 0 disables. */
  stallMinutes: number;
  /** Abort a turn that has produced nothing for this long. 0 (default) never aborts. */
  stallAbortMinutes: number;
  /**
   * Sessions started in a thread with other people's messages run restricted until the
   * owner replies !trust. "allow" gives them full tools from the start.
   */
  untrustedContext: "restrict" | "allow";
  /** Agent that runs restricted sessions; it must be an OAR Claude agent. */
  restrictedAgent: string;
  /** Files the agent's Read tool may never open (Claude permission rule paths). */
  secretPaths: string[];
  /** Per-agent-process memory cap via a systemd scope, e.g. "8G". null runs agents in the bridge's own cgroup. */
  agentMemoryMax: string | null;
  /** Where Slack attachments are saved for the agent. */
  filesDir: string;
  fileMaxMB: number;
  fileRetentionDays: number;
  /** On start, look back this far for owner messages Socket Mode did not deliver. */
  backfillMinutes: number;
  /** A schedule whose last firing was missed while the bridge was down: run it once ("run"), only tell the owner ("notify"), or ignore ("off"). */
  cronCatchUp: "run" | "notify" | "off";
  /** Only firings missed within this many hours count. */
  cronCatchUpHours: number;
}

export function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export const defaultConfig: Config = {
  ownerUserId: "",
  allowUsers: [],
  ownerOnly: true,
  allowChannels: [],
  defaultAgent: "claude",
  defaultCwd: "~",
  channelCwd: {},
  agents: {
    claude: { kind: "oar", runtime: "claude" },
    omp: { kind: "acp", command: "omp", args: ["acp"] },
    agy: { kind: "oar", runtime: "antigravity" },
  },
  idleMinutes: 30,
  maxLiveSessions: 4,
  runTimeoutMinutes: 60,
  dbPath: "~/.local/share/agent-bridge/bridge.db",
  display: "concise",
  stallMinutes: 10,
  stallAbortMinutes: 0,
  untrustedContext: "restrict",
  restrictedAgent: "claude",
  secretPaths: [
    "~/.config/agent-bridge/**",
    "~/.cc-connect/config.toml",
    "~/.ssh/**",
    "~/.aws/**",
    "~/.config/gh/hosts.yml",
    "~/.netrc",
    "~/.git-credentials",
    "/proc/*/environ",
  ],
  agentMemoryMax: "8G",
  filesDir: "~/tmp/agent-bridge/files",
  fileMaxMB: 50,
  fileRetentionDays: 7,
  backfillMinutes: 30,
  cronCatchUp: "run",
  cronCatchUpHours: 12,
};

export function loadConfig(path = process.env.AGENT_BRIDGE_CONFIG ?? "~/.config/agent-bridge/config.json"): Config {
  const raw = JSON.parse(readFileSync(expandHome(path), "utf8")) as Partial<Config>;
  const config: Config = { ...defaultConfig, ...raw, agents: { ...defaultConfig.agents, ...raw.agents } };
  if (raw.telegram && raw.dbPath === undefined) config.dbPath = "~/.local/share/agent-bridge/telegram.db";
  if (!config.ownerUserId) throw new Error("config: ownerUserId is required");
  if (!config.allowUsers.length) config.allowUsers = [config.ownerUserId];
  if (!config.agents[config.defaultAgent]) throw new Error(`config: defaultAgent ${config.defaultAgent} is not in agents`);
  const restricted = config.agents[config.restrictedAgent];
  if (!restricted || restricted.kind !== "oar" || restricted.runtime !== "claude") {
    throw new Error(`config: restrictedAgent ${config.restrictedAgent} must be an OAR claude agent`);
  }
  return config;
}
