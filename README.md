# agent-bridge

A self-hosted Slack and Telegram bridge for local coding agents.

`agent-bridge` connects chat workspaces to locally installed AI coding CLIs with persistent SQLite-backed sessions, streaming progress updates, scheduled jobs, outbound secret redaction, and per-process memory limits. It runs TypeScript directly on Node.js 24+ with no build step (and supports Bun for the Telegram entry point).

## Supported Agent Backends

| Backend | Integration | Supported Agents | Platforms |
| --- | --- | --- | --- |
| **OAR** ([`@botiverse/oar`](https://github.com/botiverse/oar)) | Native CLI runtime adapter (`"kind": "oar"`) | **Claude Code** (`claude`), **Codex** (`codex`), **Antigravity** (`antigravity` / `agy`), **Pi** (`pi`), and other OAR runtimes | Slack & Telegram |
| **ACP** ([Agent Client Protocol](https://agentclientprotocol.com)) | Built-in JSON-RPC stdio client (`"kind": "acp"`) | **`omp`** (Oh My Pi) and any ACP-compatible CLI agent | Slack |

- In **Slack**, any configured OAR or ACP agent can be selected as the default or per thread via `!chat --agent <name>`.
- In **Telegram**, the bridge loads OAR's **Codex** (`codex`) and **Antigravity** (`antigravity` / `agy`) runtimes on demand and supports live per-topic provider, model, and reasoning-effort switching.

## Core Features

- **Thread- and topic-scoped sessions** — Every Slack thread or Telegram chat/topic maps to a persistent agent session stored in SQLite (`node:sqlite`). Idle sessions are evicted automatically and resumed seamlessly from their stored session ID on the next message.
- **Native streaming & progress cards (Slack)** — Uses Slack's streaming API (`chat.startStream`, `chat.appendStream`, `chat.stopStream`) with automatic rollover for long responses and fallback to `chat.postMessage` / `chat.update`. Choose between a single updating progress card (`concise`) or per-tool timeline cards (`verbose`).
- **Rich replies & interactive controls (Telegram)** — Supports private chats, groups, and forum topics with Markdown/HTML rich messages (`sendRichMessage` with chunked plain-text fallback), stoppable generation drafts in DMs, and live `/provider`, `/model`, and `/reasoning` switching.
- **One-shot & scheduled automation** — Run one-off tasks (`!run`) or recurring cron schedules (5- or 6-field expressions) in `fresh` (new thread per firing) or `continue` (resume session) mode, with `--silent` output, `--exec` shell commands, overlap skipping, and missed-run catch-up.
- **Defense-in-depth security** — Owner/allowlist access control, 🔒 read-only restricted mode for guests and untrusted Slack threads, sensitive-path deny rules for Claude, stripped bridge tokens in agent subprocesses, and automatic outbound secret redaction.
- **Reliability & resource isolation** — Stall watchdog, Slack Socket Mode backfill with SQLite message deduplication, automatic attachment cleanup, and optional per-agent `systemd-run --user --scope` memory caps on Linux.

## Requirements

- **Node.js 24+** (uses native TypeScript execution and `node:sqlite`; no build step required).
- **Bun** (optional; supported as an alternative runtime for the Telegram entry point).
- One or more **locally installed and authenticated** coding agent CLIs (for example, `claude`, `codex`, `agy`, or `omp`). Each must work when you run it by hand in a terminal as the same OS user.
- **Slack bridge:** Claude Code (`claude`) is required even if your default agent is something else, because 🔒 read-only sessions (guests and untrusted threads) always run on Claude.
- **Telegram bridge:** `python3` and `curl` on `PATH` for the file-upload helper (`bridge-send`).
- **Linux `systemd --user`** (optional; required only if you enable per-agent memory caps via `agentMemoryMax` or run the sample systemd services). On macOS and other systems the bridge runs fine with `npm start`; agents simply run without a per-process memory cap.

## Installation

```sh
git clone https://github.com/zhoukuncheng/agent-bridge.git ~/agent-bridge
cd ~/agent-bridge
npm ci
```

Recent npm versions may print an `install-scripts` warning about `protobufjs`'s postinstall step; the bridge does not need it, so the warning can be ignored.

## Slack Bridge

### 1. Create a Slack App

Use a dedicated Slack app with **Socket Mode**. The quickest path is the bundled manifest:

1. Open <https://api.slack.com/apps> → **Create New App** → **From a manifest**, pick your workspace, and paste [`deploy/slack-app-manifest.yaml`](deploy/slack-app-manifest.yaml).
2. **Basic Information → App-Level Tokens → Generate Token and Scopes**, add the `connections:write` scope. This `xapp-...` token is `SLACK_APP_TOKEN`.
3. **Install App** to the workspace and copy the **Bot User OAuth Token**. This `xoxb-...` token is `SLACK_BOT_TOKEN`.
4. Invite the bot to any channel where you want to use it (`/invite @agent-bridge`). DMs work without an invite.

If you configure the app by hand instead, it needs:

- **Bot Token Scopes**: `app_mentions:read`, `channels:history`, `chat:write`, `files:read` (attachments), `groups:history`, `im:history`, `im:read`, `im:write`, `mpim:history`, `users:read` (names in thread context)
- **Event Subscriptions** (bot events): `app_mention`, `message.channels`, `message.groups`, `message.im`, `message.mpim`

> **Important:** Use a dedicated Slack app for `agent-bridge`. Slack distributes Socket Mode events across every active connection for an app, so sharing an app with another bot causes messages to split unpredictably.

**Finding IDs for the config:** your Slack user ID (`ownerUserId`, `allowUsers`) is under your profile → **⋮ → Copy member ID** (starts with `U`). A channel ID (`allowChannels`, `channelCwd`) is at the bottom of the channel's **About** tab, or in its link (starts with `C`, or `G` for older private channels).

### 2. Configure and Run

Create your configuration and credentials file:

```sh
mkdir -p ~/.config/agent-bridge
cp deploy/config.example.json ~/.config/agent-bridge/config.json
# Edit ~/.config/agent-bridge/config.json and set ownerUserId, defaultCwd, and agents

printf 'SLACK_BOT_TOKEN=xoxb-...\nSLACK_APP_TOKEN=xapp-...\n' > ~/.config/agent-bridge/env
chmod 600 ~/.config/agent-bridge/env
```

Run directly:

```sh
set -a; source ~/.config/agent-bridge/env; set +a
npm start
```

The bridge logs `agent-bridge up as @<bot> ...` once it is connected. DM the bot `!help` to check the round trip.

Or run as a Linux `systemd --user` service. Open [`deploy/agent-bridge.service`](deploy/agent-bridge.service) first and adjust `WorkingDirectory` (your clone), `PATH` (where `node` and your agent CLIs live; a user service does not read your shell profile, so nvm/fnm installs need their bin directory added), and `MemoryMax`:

```sh
mkdir -p ~/.config/systemd/user
cp deploy/agent-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now agent-bridge
journalctl --user -u agent-bridge -f      # logs
loginctl enable-linger "$USER"            # optional: keep running after logout
```

### 3. Slack Usage & Commands

Commands are plain messages starting with `!` (no Slack slash commands are required).

| Action / Command | Behavior |
| --- | --- |
| Mention the bot in a channel, or DM it | Starts a session with `defaultAgent`, posts a thread header, and streams the answer. |
| Mention the bot inside an existing thread | Starts a session there and passes earlier thread messages as quoted context. If anyone outside `allowUsers` wrote in the thread, the session starts 🔒 read-only by default (`untrustedContext: "restrict"`). |
| Reply inside a bridge thread (no mention needed) | Continues the same session. Messages sent while a turn is running are steered into the turn (Claude) or queued (ACP agents). |
| Attach files to a message | Downloads attachments to `filesDir/<channel>-<thread>/` and passes their local paths to the agent. |
| `!chat` / `!new [--agent A] [--model M] [--cwd DIR] <prompt>` | Starts a session with a specific agent, model, or working directory. |
| `!run [--agent A] [--model M] [--cwd DIR] [--timeout MIN] <prompt>` | Runs a one-shot task and releases the process afterward. Replying in the thread resumes the session. |
| `!cron add "<expr>" [options] <prompt>` | Adds a 5-field (or 6-field with seconds) cron schedule. Options: `--agent A`, `--model M`, `--cwd DIR`, `--channel here\|dm\|#chan`, `--mode fresh\|continue`, `--tz TZ`, `--name N`, `--timeout MIN`, `--silent`, `--exec`. |
| `!cron list` · `run <id>` · `pause <id>` · `resume <id>` · `rm <id>` | Lists, manually triggers, pauses, resumes, or deletes schedules. |
| `!stop` · `!status` · `!release` *(in a thread)* | Interrupts the active turn; in a channel thread it also makes the thread mention-only, so later replies reach the agent only when they mention the bot (the session continues) · shows session info · disposes the live process (the next reply resumes it). |
| `!trust [prompt]` *(in a 🔒 thread)* | Lifts read-only restriction and grants full tools; sends `prompt` immediately if provided. |
| `!concise` · `!verbose` *(in a thread)* | Switches tool-call rendering mode for the thread starting on the next turn. |
| `!help` | Displays the command summary. |

**Schedule flags:**
- `--mode fresh` opens a new thread on every firing; `--mode continue` reuses one thread and resumes its session.
- `--silent` skips headers and streaming, posting only the final answer (`NO_REPLY` posts nothing). Replying to the posted answer resumes the session.
- `--exec` executes the prompt as a shell command via `sh -c` in the schedule's working directory and posts stdout/stderr.

### 4. Streaming & Display Modes

- **`display: "concise"` (default)** — Folds a turn's tool calls and intermediate narration into a single updating progress card (summarized at completion, e.g., `5 steps · Bash ×3, Read ×2`) while streaming only the final answer as text. Text is held for up to 2.5 seconds; if a tool call follows, it becomes the progress card title instead of streaming into the answer.
- **`display: "verbose"`** — Renders one timeline card per tool call (with input and output) and streams all text.
- Long answers automatically roll over into a follow-up message. If Slack streaming fails, the bridge falls back to `chat.postMessage` + `chat.update`.
- Every turn ends with a footer showing outcome, duration, and—when reported by the agent—model, context usage, and cost. (Agents that do not report a model name, such as `agy`, omit that field.)

## Telegram Bridge

The Telegram bridge (`src/telegram/main.ts`) connects a Telegram bot directly to OAR's **Codex** and **Antigravity** runtimes over long polling. Each turn owns a dedicated OAR session that is disposed when the turn completes, while SQLite stores native conversation IDs per chat, topic, and provider so conversations resume seamlessly.

### 1. Configure and Run

Create a dedicated config file (set `AGENT_BRIDGE_CONFIG`) and a mode-`0600` token file (set `AGENT_BRIDGE_TOKEN_FILE`, or pass `TELEGRAM_BOT_TOKEN`):

```json
{
  "ownerUserId": "123456789",
  "defaultCwd": "/path/to/workspace",
  "dbPath": "~/.local/share/agent-bridge/telegram.db",
  "cronCatchUp": "off",
  "telegram": {
    "agent": "codex",
    "model": "your-codex-model",
    "effort": "medium",
    "fullAccess": false,
    "providers": {
      "codex": { "model": "your-codex-model", "effort": "medium" },
      "antigravity": { "model": "your-antigravity-model" }
    }
  }
}
```

- `ownerUserId` must be the owner's **numeric** Telegram user ID. Only this owner can invoke the bot; messages from other users, bots, anonymous administrators, and channels are ignored.
- `telegram.agent` selects the default provider: `codex` (default) or `antigravity` (`agy` is accepted as an alias).
- **Provider permissions:** Codex inherits its native sandbox configuration unless `telegram.fullAccess: true` is set. Because OAR's Antigravity ACP adapter auto-approves tool requests, using Antigravity requires explicitly setting `"fullAccess": true`. Enable `fullAccess` only when unrestricted local tool execution is intended for the owner.

Run with Node.js 24+ or Bun:

```sh
export AGENT_BRIDGE_CONFIG=~/.config/agent-bridge/telegram.json
export AGENT_BRIDGE_TOKEN_FILE=~/.config/agent-bridge/telegram.token

# Using Node.js 24+
node src/telegram/main.ts

# Or using Bun
bun --smol src/telegram/main.ts
```

A sample `systemd --user` unit is provided in [`deploy/agent-bridge-telegram.service`](deploy/agent-bridge-telegram.service). Adjust `WorkingDirectory`, `PATH`, and the config/token paths, then install it the same way as the Slack unit (`systemctl --user daemon-reload && systemctl --user enable --now agent-bridge-telegram`). Make sure no other poller is consuming updates for the same bot token before starting the service.

To get the numeric `ownerUserId`, message [@userinfobot](https://t.me/userinfobot) or read `message.from.id` from the bot's `getUpdates` response.

### 2. Telegram Usage & Commands

Works in private chats with the owner, as well as groups and forum topics (where the bot responds to `@mentions`, replies to the bot, and slash commands, subject to Telegram's group privacy settings).

| Command / Input | Behavior |
| --- | --- |
| Plain message *(DM)* or `@bot` / reply *(group)* | Sends a prompt to the active provider for this chat/topic. |
| `/ask <prompt>` | Explicitly sends a prompt to the active provider. |
| `/html <prompt>` | Requests a response formatted in Telegram rich-message HTML. |
| `/provider` · `/provider codex` · `/provider antigravity` | Shows or switches the backend for the current topic. Each provider preserves its own conversation history. |
| `/model` · `/model <MODEL_ID>` | Lists available OAR models for the active provider or selects one. |
| `/reasoning` · `/reasoning <LEVEL>` | Lists supported reasoning effort levels for the active model or sets one. |
| `/new` | Clears the active provider's saved conversation in the current topic. |
| `/stop` | Aborts the running turn. Private chats also support stoppable generation drafts (`sendRichMessageDraft`). |
| `/cron` · `/cron list` | Displays scheduled jobs and the shared Telegram schedule provider/model settings. |
| `/cron set <provider> <model> [reasoning]` | Validates against the live OAR model catalog and sets the shared provider, model, and optional reasoning level for all agent-backed Telegram schedules (effective from the next firing; shell `--exec` jobs run directly). |
| `/help` | Shows available commands. |

- Per-topic provider/model/reasoning selections and shared `/cron` settings are persisted in SQLite across restarts.
- Replies use `sendRichMessage` (Markdown or HTML) with automatic chunked plain-text fallback (`sendMessage`).
- Agent and shell processes run with [`deploy/telegram-bin`](deploy/telegram-bin) prepended to `PATH`. It provides `bridge-send send --file PATH --image PATH`, which uploads files and images to the active chat or topic (requires `python3` and `curl`). `cc-connect` is kept as an alias so jobs imported from cc-connect keep working.

## Configuration Reference

By default, configuration is loaded from `~/.config/agent-bridge/config.json` (override with `AGENT_BRIDGE_CONFIG`).

| Option | Default | Description |
| --- | --- | --- |
| `ownerUserId` | *(required)* | Owner's Slack user ID, or numeric Telegram user ID. |
| `allowUsers` | `[ownerUserId]` | Slack users granted full access. |
| `ownerOnly` | `true` | Slack: when `true`, non-`allowUsers` are silently ignored; when `false`, guests may interact in 🔒 read-only mode. |
| `allowChannels` | `[]` | Slack channel ID allowlist (empty allows any channel the bot is in; DMs with allowed users always work). |
| `defaultAgent` | `"claude"` | Default Slack agent key from `agents`. |
| `defaultCwd` | `"~"` | Default working directory for sessions and schedules. |
| `channelCwd` | `{}` | Per-channel working directory overrides (`{ "<channelId>": "/path" }`). |
| `agents` | `claude`, `omp`, `agy` | Map of agent definitions (`kind: "oar"` or `kind: "acp"`). |
| `display` | `"concise"` | Slack turn display mode: `"concise"` or `"verbose"`. |
| `idleMinutes` | `30` | Dispose idle live sessions after this many minutes (next message resumes). |
| `maxLiveSessions` | `4` | Maximum concurrent live sessions (LRU idle eviction on Slack; active turn cap on Telegram). |
| `runTimeoutMinutes` | `60` | Default timeout (minutes) for one-shot runs, scheduled runs, and Telegram turns. |
| `stallMinutes` | `10` | Post a warning in the Slack thread after this many silent minutes (`0` disables). |
| `stallAbortMinutes` | `0` | Abort a stalled Slack turn after this many silent minutes (`0` disables). |
| `untrustedContext` | `"restrict"` | Slack: `"restrict"` locks threads containing messages from non-`allowUsers` until `!trust`; `"allow"` grants full tools immediately. |
| `restrictedAgent` | `"claude"` | Agent used for 🔒 read-only Slack sessions (must be an OAR `claude` agent). |
| `secretPaths` | *(see below)* | Paths denied to Claude's `Read` and `Edit` tools. |
| `agentMemoryMax` | `"8G"` | Per-agent Linux `systemd-run --user --scope` `MemoryMax` (`null` disables). |
| `filesDir` | `"~/tmp/agent-bridge/files"` | Directory where Slack attachments are saved. |
| `fileMaxMB` | `50` | Maximum download size (MB) per Slack attachment. |
| `fileRetentionDays` | `7` | Delete downloaded Slack attachments older than this many days. |
| `backfillMinutes` | `30` | Lookback window on startup for missed Slack Socket Mode messages. |
| `cronCatchUp` | `"run"` | Missed schedule policy on startup: `"run"`, `"notify"`, or `"off"`. |
| `cronCatchUpHours` | `12` | Only catch up schedules missed within this many hours. |
| `dbPath` | `~/.local/share/agent-bridge/bridge.db` | SQLite database path (defaults to `telegram.db` when `telegram` is set and `dbPath` is omitted). |
| `telegram` | *(optional)* | Telegram settings: `agent`, `model`, `effort`, `fullAccess`, and per-provider `providers.{codex,antigravity}`. |

### Environment Variables

| Variable | Used By | Purpose |
| --- | --- | --- |
| `AGENT_BRIDGE_CONFIG` | Slack & Telegram | Path to JSON config file (default `~/.config/agent-bridge/config.json`). |
| `SLACK_BOT_TOKEN` | Slack | Slack Bot User OAuth Token (`xoxb-...`). |
| `SLACK_APP_TOKEN` | Slack | Slack App-Level Token (`xapp-...`) for Socket Mode. |
| `TELEGRAM_BOT_TOKEN` | Telegram | Telegram Bot API token (alternative to `AGENT_BRIDGE_TOKEN_FILE`). |
| `AGENT_BRIDGE_TOKEN_FILE` | Telegram | Path to a mode-`0600` file containing the Telegram Bot API token. |

## Security Model

- **Access Control**
  - **Slack:** With `ownerOnly: true` (default), only `allowUsers` can interact with the bot. With `ownerOnly: false`, other users can mention or DM the bot, but their sessions are always 🔒 read-only, scoped to sessions they started, and limited to `!help` and `!stop`.
  - **Telegram:** Strictly restricted to the single numeric `ownerUserId`.
- **🔒 Read-Only Sessions (Slack)**
  - Run through `restrictedAgent` (an OAR Claude agent) with `--permission-mode dontAsk`, user settings and MCP servers excluded (`userConfiguration: "exclude"`), only `Read`, `Grep`, and `Glob` allowed (scoped to the session's working directory for guest sessions), and shell/write/edit/subagent/scheduling/messaging tools explicitly denied.
  - Under the default `untrustedContext: "restrict"`, even an allowed user's session started inside a thread containing messages from non-`allowUsers` starts read-only until `!trust` is issued. Earlier thread messages are always passed as quoted context with angle brackets escaped and instructions not to follow them.
- **Secret Protection & Outbound Redaction**
  - Bridge tokens (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `TELEGRAM_BOT_TOKEN`) are stripped from agent subprocess environments.
  - Claude's `Read` and `Edit` tools are denied `secretPaths` (by default covering sensitive credential paths such as `~/.config/agent-bridge/**`, `~/.ssh/**`, `~/.aws/**`, `~/.config/gh/hosts.yml`, `~/.netrc`, `~/.git-credentials`, and `/proc/*/environ`; see [`src/config.ts`](src/config.ts) for the full default list).
  - All outbound content (messages, Slack stream chunks, task cards, and Telegram replies/errors) passes through `Redactor`, which masks common credential patterns (Slack, AWS, GitHub, GitLab, `sk-...`, Google, npm, JWT, private keys), `password=...`-style assignments, and exact values of secret-looking environment variables. Slack streaming flushes on whitespace boundaries so tokens are not split across chunks.
  - **Important caveat:** Full-tool agent sessions run as your local OS user and can read files via shell commands. Outbound redaction helps prevent accidental leakage into chat, but it is **not** an OS-level sandbox.
- **ACP Permissions**
  - When an ACP agent requests tool permission, the bridge grants `allow_once` (never `allow_always`) and cancels the request if no allow option is offered.

## Reliability & Resource Management

- **Session lifecycle:** Idle sessions are closed after `idleMinutes`, and the least recently used idle session is evicted when `maxLiveSessions` is reached. The next reply resumes the session from SQLite.
- **Stall watchdog (Slack):** Warns in the thread after `stallMinutes` without agent events, and optionally aborts after `stallAbortMinutes`.
- **Missed-message backfill (Slack):** Because Socket Mode can drop events, the bridge scans the owner's DM and recently active threads on startup (up to `backfillMinutes`), on reconnect, and every 2 minutes. Messages are claimed in SQLite before dispatch so each event is handled at most once. Mentions in channel messages outside existing bridge threads are not backfilled.
- **Schedules:** Overlapping firings of the same schedule are skipped while a previous run is still active. Missed firings within `cronCatchUpHours` follow `cronCatchUp` (`run`, `notify`, or `off`). Failed firings notify the owner via DM.
- **Per-agent memory caps (Linux):** When `agentMemoryMax` is set and `systemd-run --user --scope` is available, each agent process runs inside its own memory-capped scope with swap disabled (`MemorySwapMax=0`), isolating OOM kills from the bridge itself.

## Development & Testing

```sh
# Type-check
npm run typecheck

# Unit tests (fake Slack/Telegram APIs, fake agents, scripted ACP fixture)
npm test

# Bun runtime smoke test
bun --smol scripts/bun-smoke.ts
```

### Live End-to-End Tests

Live E2E scripts exercise real APIs and real local agent CLIs:

- **Slack E2E:** Requires `SLACK_BOT_TOKEN` plus explicit target flags (`--channel` and `--owner`). Inbound events are injected directly into the router so live tests can run without competing with a running Socket Mode daemon, while outbound streaming, thread reads, and agent sessions execute against Slack and local CLIs:

  ```sh
  SLACK_BOT_TOKEN=xoxb-... npm run e2e -- --channel "$SLACK_CHANNEL_ID" --owner "$SLACK_USER_ID"
  ```

- **Telegram E2E:** Uses `AGENT_BRIDGE_CONFIG` and `AGENT_BRIDGE_TOKEN_FILE` (or `TELEGRAM_BOT_TOKEN`) with an in-memory SQLite store to dispatch a synthetic owner turn, resume the provider conversation, and verify two real Telegram receipts without starting the poller or running production schedules:

  ```sh
  bun --smol scripts/telegram-e2e.ts
  ```

## Migrating from cc-connect

[`scripts/migrate-cc-connect.ts`](scripts/migrate-cc-connect.ts) imports cc-connect cron jobs into the bridge's schedule table. Stop the bridge first (schedules load at startup), preview with `--dry-run`, then run it for real:

```sh
node scripts/migrate-cc-connect.ts --dry-run [--platform slack|telegram] [--jobs ~/.cc-connect/crons/jobs.json] [--cwd ~/code] [--agent NAME]
```

Jobs keep their cron expression, target, exec/silent flags, timeout, and enabled state (disabled jobs come over paused). Re-running skips jobs already imported. Use `--platform telegram` with `AGENT_BRIDGE_CONFIG` pointing at the Telegram config. Stop cc-connect before starting the bridge on the same bot token or Slack app.

## Project Structure

```text
src/
  main.ts            Slack bridge entry point (Socket Mode, backfill, lifecycle)
  bridge.ts          Core wiring (drivers, redaction, manager, router, scheduler)
  config.ts          Configuration schema, defaults, and loader
  store.ts           SQLite persistence (node:sqlite)
  agents/            Agent contract (types.ts), OAR adapter (oar.ts), ACP client (acp.ts),
                     and per-process systemd scopes (memcap.ts)
  core/              Router, session manager, turn bindings, command parser, one-shot runner,
                     attachments, and Socket Mode backfill
  slack/             Slack Web API wrapper, streaming/card renderer, Bolt Socket Mode app
  telegram/          Telegram long-polling entry point, Bot API client, routing, OAR
                     provider integration, per-topic/cron preferences, and scheduler service
  sched/             Cron scheduler (croner, catch-up) and shell exec runner
  security/          Outbound secret redactor
scripts/             Utility scripts, Bun smoke test, and Slack/Telegram E2E scripts
deploy/              Example config, Slack app manifest, systemd user units, and Telegram upload helper
test/                Node test suite and ACP test fixtures
```

## References

- **[OAR (`@botiverse/oar`)](https://github.com/botiverse/oar)** — Open Agent Runtime, providing a unified programmatic interface across coding agent harnesses (Claude Code, Codex, Antigravity, Pi, and more).
- **[cc-connect](https://github.com/chenhg5/cc-connect)** — Open-source bridge connecting local AI coding agents to Slack, Telegram, and other messaging platforms.
- **[Agent Client Protocol (ACP)](https://agentclientprotocol.com)** — Protocol implemented by the built-in ACP client for ACP-compatible agents such as `omp`.

## License

[MIT](LICENSE)
