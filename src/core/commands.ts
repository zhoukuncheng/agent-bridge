// Text commands. The Slack app has no slash commands, so everything is a message
// starting with "!". Plain text with no command starts (or continues) a chat.

export interface RunOptions {
  agent?: string;
  model?: string;
  cwd?: string;
  timeoutMinutes?: number;
}

export interface CronAddOptions extends RunOptions {
  expr: string;
  channel?: string;
  mode?: "fresh" | "continue";
  tz?: string;
  name?: string;
  /** Post only the final answer, with no header or streaming. */
  silent?: boolean;
  /** The prompt is a shell command run with `sh -c`; its output is posted. */
  exec?: boolean;
}

export type Command =
  | { kind: "chat"; options: RunOptions; prompt: string }
  | { kind: "run"; options: RunOptions; prompt: string }
  | { kind: "cron_add"; options: CronAddOptions; prompt: string }
  | { kind: "cron_list" }
  | { kind: "cron_rm" | "cron_pause" | "cron_resume" | "cron_run"; id: number }
  | { kind: "stop" | "status" | "release" | "help" }
  | { kind: "trust"; prompt: string }
  | { kind: "display"; display: "concise" | "verbose" }
  | { kind: "error"; message: string };

/** Slack escapes &, < and > and wraps links/mentions in <...>; undo what matters for prompts. */
export function decodeSlackText(text: string): string {
  return text
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_m, url: string, label: string) => (label === url.replace(/^mailto:/, "") ? label : `${label} (${url})`))
    .replace(/<((?:https?|mailto):[^>]+)>/g, "$1")
    .replace(/<#(C[A-Z0-9]+)(?:\|[^>]*)?>/g, "<#$1>")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
}

export function stripMention(text: string, botUserId: string): string {
  return text.replace(new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, "g"), "").trim();
}

/** Reads one token (quoted or bare) at `pos`, returning it and the position after it. */
function readToken(text: string, pos: number): { token: string; end: number } | undefined {
  while (pos < text.length && /\s/.test(text[pos]!)) pos++;
  if (pos >= text.length) return undefined;
  const quote = text[pos];
  if (quote === '"' || quote === "'") {
    const close = text.indexOf(quote, pos + 1);
    if (close === -1) return { token: text.slice(pos + 1), end: text.length };
    return { token: text.slice(pos + 1, close), end: close + 1 };
  }
  let end = pos;
  while (end < text.length && !/\s/.test(text[end]!)) end++;
  return { token: text.slice(pos, end), end };
}

const valueOptions = new Set(["agent", "model", "cwd", "timeout", "channel", "mode", "tz", "name"]);
const flagOptions = new Set(["silent", "exec"]);

/** Parses leading `--name value` options; the rest of the text (verbatim) is the prompt. */
export function parseOptions(text: string): { options: Record<string, string>; rest: string } | { error: string } {
  const options: Record<string, string> = {};
  let pos = 0;
  for (;;) {
    const next = readToken(text, pos);
    if (!next || !next.token.startsWith("--")) break;
    const name = next.token.slice(2);
    if (flagOptions.has(name)) {
      options[name] = "true";
      pos = next.end;
      continue;
    }
    if (!valueOptions.has(name)) return { error: `unknown option --${name}` };
    const value = readToken(text, next.end);
    if (!value) return { error: `--${name} needs a value` };
    options[name] = value.token;
    pos = value.end;
  }
  return { options, rest: text.slice(pos).trim() };
}

function runOptions(raw: Record<string, string>): RunOptions | string {
  const out: RunOptions = {};
  if (raw.agent) out.agent = raw.agent;
  if (raw.model) out.model = raw.model;
  if (raw.cwd) out.cwd = raw.cwd;
  if (raw.timeout) {
    const minutes = Number(raw.timeout);
    if (!Number.isFinite(minutes) || minutes <= 0) return `--timeout must be a positive number of minutes`;
    out.timeoutMinutes = minutes;
  }
  return out;
}

export function parseCommand(input: string): Command {
  const text = input.trim();
  if (!text.startsWith("!")) return { kind: "chat", options: {}, prompt: text };
  const head = readToken(text, 1);
  const name = head?.token.toLowerCase() ?? "";
  const rest = head ? text.slice(head.end) : "";

  switch (name) {
    case "help":
      return { kind: "help" };
    case "stop":
    case "status":
    case "release":
      return { kind: name };
    case "trust":
      return { kind: "trust", prompt: rest.trim() };
    case "verbose":
    case "concise":
      return { kind: "display", display: name };
    case "new":
    case "chat":
    case "run": {
      const parsed = parseOptions(rest);
      if ("error" in parsed) return { kind: "error", message: parsed.error };
      const options = runOptions(parsed.options);
      if (typeof options === "string") return { kind: "error", message: options };
      if (!parsed.rest) return { kind: "error", message: `!${name} needs a prompt` };
      return { kind: name === "run" ? "run" : "chat", options, prompt: parsed.rest };
    }
    case "cron": {
      const sub = readToken(rest, 0);
      const subName = sub?.token.toLowerCase();
      const after = sub ? rest.slice(sub.end) : "";
      if (!subName || subName === "list" || subName === "ls") return { kind: "cron_list" };
      if (subName === "add") {
        const expr = readToken(after, 0);
        if (!expr) return { kind: "error", message: `usage: !cron add "<cron expr>" [--agent A] [--channel here|dm|#chan] [--mode fresh|continue] <prompt>` };
        const parsed = parseOptions(after.slice(expr.end));
        if ("error" in parsed) return { kind: "error", message: parsed.error };
        const options = runOptions(parsed.options);
        if (typeof options === "string") return { kind: "error", message: options };
        const mode = parsed.options.mode;
        if (mode && mode !== "fresh" && mode !== "continue") return { kind: "error", message: "--mode must be fresh or continue" };
        if (!parsed.rest) return { kind: "error", message: "!cron add needs a prompt" };
        return {
          kind: "cron_add",
          options: {
            ...options,
            expr: expr.token,
            channel: parsed.options.channel,
            mode: mode as CronAddOptions["mode"],
            tz: parsed.options.tz,
            name: parsed.options.name,
            silent: parsed.options.silent === "true",
            exec: parsed.options.exec === "true",
          },
          prompt: parsed.rest,
        };
      }
      const action = { rm: "cron_rm", delete: "cron_rm", pause: "cron_pause", resume: "cron_resume", run: "cron_run" }[subName] as
        | "cron_rm"
        | "cron_pause"
        | "cron_resume"
        | "cron_run"
        | undefined;
      if (!action) return { kind: "error", message: `unknown !cron subcommand "${subName}"` };
      const id = Number(readToken(after, 0)?.token.replace(/^#/, ""));
      if (!Number.isInteger(id) || id <= 0) return { kind: "error", message: `!cron ${subName} needs a schedule id` };
      return { kind: action, id };
    }
    default:
      return { kind: "error", message: `unknown command !${name} — try !help` };
  }
}

export const helpText = [
  "*agent-bridge* — talk to coding agents from Slack.",
  "• Mention me (or DM me) to start a session; each session lives in its own thread. Reply in the thread to continue.",
  "• `!chat` (or `!new`) `--agent A [--model M] [--cwd DIR] <prompt>` — start a session with a specific agent from the config.",
  "• `!run [--agent A] [--timeout MIN] <prompt>` — one-shot task; the thread can still be continued afterwards.",
  '• `!cron add "0 9 * * 1-5" [--name N] [--agent A] [--channel here|dm|#chan] [--mode fresh|continue] [--tz Asia/Shanghai] [--timeout MIN] [--silent] [--exec] <prompt or shell command>`',
  "  `--silent` posts only the final answer; `--exec` runs the text with `sh -c` and posts its output.",
  "• `!cron list` · `!cron run <id>` · `!cron pause <id>` · `!cron resume <id>` · `!cron rm <id>`",
  "• In a session thread: `!stop` interrupts the turn and, in a channel, stops answering replies that don't mention me · `!status` · `!release` frees the process (the next reply resumes) · `!verbose` / `!concise` switch how tool calls are shown.",
  "• 🔒 Sessions started in a thread with other people's messages are read-only. `!trust [prompt]` gives the agent full tools.",
  "• Attach files to a message and the agent gets them as local paths.",
].join("\n");
