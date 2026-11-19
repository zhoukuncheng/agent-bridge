# agent-bridge

Run local coding agents from Slack. Every agent session lives in its own Slack thread.
Answers stream into the thread as they are written, and each tool call shows up as a
task card while it runs. One-shot runs and scheduled runs are supported too.

The first version supports **Claude Code**, **omp** (Oh My Pi) and **Antigravity** (`agy`).

- **Claude Code** runs through [`@botiverse/oar`](https://github.com/botiverse/oar),
  which drives `claude -p` stream-json. OAR tracks new CLI releases, so picking up new
  native features is mostly a dependency bump.
- **Antigravity** also runs through OAR (`agy acp`), with `{"kind": "oar", "runtime": "antigravity"}`.
  agy reports no model name, so its turn footer shows only the outcome, the duration and the
  context use.
- Codex and Pi are one config entry away (`{"kind": "oar", "runtime": "codex"}`), but they
  have not been tested here yet.
- **omp** runs through a small built-in [ACP](https://agentclientprotocol.com) client
  (`omp acp`). OAR's Pi runtime refuses omp's version string. Any other ACP agent can
  use the same `"kind": "acp"` entry.

## How it behaves

| You do | The bridge does |
|---|---|
| Mention the bot in a channel, or DM it | Starts a session (default agent). It posts a header in the thread, then streams the answer |
| Mention the bot inside someone else's thread | Starts a session there and gives the agent the thread's earlier messages first, as quoted information. If anyone outside `allowUsers` wrote in the thread, the session starts 🔒 read-only, unless `untrustedContext: "allow"` is set (see Security) |
| Reply in that thread (no mention needed) | Continues the same session. A reply sent while a turn is running is steered into it (Claude) or queued (omp) |
| Attach files to the message | Downloads them to `filesDir/<channel>-<thread>/` and gives the agent their local paths |
| `!chat` / `!new` `--agent omp [--model M] [--cwd DIR] <prompt>` | Starts a session with a specific agent, model or working directory |
| `!run [--agent A] [--timeout MIN] <prompt>` | Runs a one-shot task, then frees the process. Replying in the thread resumes it |
| `!cron add "<expr>" [--agent A] [--channel here\|dm\|#chan] [--mode fresh\|continue] [--tz TZ] <prompt>` | Adds a schedule. The expression has 5 fields, or 6 with seconds. `fresh` opens a new thread for every run; `continue` keeps one thread and resumes its session |
| `!cron add … --silent` | Runs without a header or streaming, then posts only the final answer (`NO_REPLY` posts nothing). Replying to that answer resumes the run's session |
| `!cron add … --exec <shell command>` | Runs the command with `sh -c` in the working directory and posts stdout and stderr, as cc-connect's `--exec` did |
| `!cron add … --name N --timeout MIN` | Sets the label shown in headers and `!cron list`, and the timeout for this schedule |
| `!cron list` · `run <id>` · `pause <id>` · `resume <id>` · `rm <id>` | Manages schedules |
| `!stop` · `!status` · `!release` (inside a thread) | Interrupts the turn · shows session info · frees the process (the next reply resumes it) |
| `!trust [prompt]` (inside a 🔒 thread) | Gives the session full tools; with a prompt, sends it right away |
| `!concise` · `!verbose` (inside a thread) | Switches how that thread shows tool calls, from the next turn |
| `!help` | Shows the command list |

### How replies look

- Answers use Slack's native streaming API (`chat.startStream`, `chat.appendStream`, `chat.stopStream`).
- `display: "concise"` (the default) folds a turn's tool calls and the narration between
  them into one progress card that updates in place. Its title is what the agent is doing
  now; at the end it summarises the steps, such as `5 steps · Bash ×3, Read ×2`. Only the
  answer streams as text.
  - Text is held for up to 2.5 s. If a tool call follows, the text was narration and becomes
    the card's title. If not, it streams as the answer.
- `display: "verbose"` shows one timeline card per tool call, with its input and output, and
  streams all text.
- A long answer rolls over into a new message.
- If streaming fails, the bridge falls back to `chat.postMessage` plus `chat.update`.
- Every turn ends with a footer: outcome, duration, model, context use and cost where the agent reports them.

### Sessions, schedules and reliability

- Sessions are keyed by `(channel, thread_ts)` and stored in SQLite.
- A session idle for `idleMinutes` is disposed. So is the least recently used idle
  session when `maxLiveSessions` is reached. The next message in its thread resumes it
  from the stored session id.
- **Stall watchdog.** After `stallMinutes` (default 10) without any agent event, the
  thread gets a warning. With `stallAbortMinutes` set, the turn is also stopped.
- **Missed messages.** Socket Mode can drop events. The bridge looks back over the owner's
  DM and its recently active threads in three cases:
  - on start, for messages that arrived while it was down (up to `backfillMinutes`);
  - on every reconnect;
  - every 2 minutes.

  Each Slack message is claimed in SQLite before it is handled, so it is handled only once
  across live events, backfill and restarts. An edit that adds a mention of the bot counts
  as a new request. Mentions in channel messages outside the bridge's threads are not backfilled.
- **Schedules.** A firing is skipped while the previous run of the same schedule is still
  going. If the bridge was down at a firing time within the last `cronCatchUpHours`, it
  catches up on start, depending on `cronCatchUp`:
  - `run` (the default): DMs the schedule's owner, then runs it once;
  - `notify`: only DMs the owner;
  - `off`: does nothing.

  A firing that throws is reported to the owner by DM.
- **Memory.** With `agentMemoryMax` (default `8G`), every agent process runs in its own
  `systemd-run --user --scope` with that `MemoryMax` and no swap. A runaway agent is
  killed alone, not the bridge. OAR runtimes are pointed at wrapper scripts through
  `OAR_CLAUDE_BIN` and `OAR_ANTIGRAVITY_BIN`.
- Attachments older than `fileRetentionDays` are deleted.

### Security

- **Who can use it.** With `ownerOnly: true` (the default), only `allowUsers` can talk to
  or mention the bot. It defaults to `ownerUserId`, and anyone else is ignored without a
  reply. With `ownerOnly: false`, other people can mention or DM it. Their sessions are
  always 🔒 read-only, they can talk only in sessions they started, and they can use only
  `!help` and `!stop` on their own sessions.
- **🔒 Read-only sessions** run on `restrictedAgent`, which must be an OAR Claude agent:
  - Claude loads none of your user settings, MCP servers or allow rules (`--setting-sources project,local`, `--strict-mcp-config`);
  - it runs in `--permission-mode dontAsk` and may use only Read, Grep and Glob;
  - Bash, writing and editing tools, agent-spawning tools, scheduling tools and messaging tools are denied outright. This matters because Claude would otherwise auto-approve "read-only" shell commands such as `cat`.

  A guest's session is always read-only. By default (`untrustedContext: "restrict"`), an
  allowed user's session in a thread where someone outside `allowUsers` has written is
  also read-only until `!trust`. Setting `untrustedContext: "allow"` gives those sessions
  full tools from the start, which exposes a full-tool agent to injected instructions in
  other people's messages. Under `"allow"`, threads locked earlier unlock on their next
  owner message. Either way, the thread's messages are passed as quoted information with
  angle brackets escaped, and the agent is told not to follow them.
- **Secrets.**
  - Agent processes do not inherit `SLACK_BOT_TOKEN` or `SLACK_APP_TOKEN`.
  - Claude's Read and Edit tools are denied the `secretPaths`: the bridge's env file, cc-connect's config, `~/.ssh`, `~/.aws`, gh hosts, `.netrc`, `.git-credentials` and `/proc/*/environ`.
  - Everything the bridge posts to Slack is redacted: text, stream chunks and task cards. That covers token shapes (Slack, AWS, GitHub, GitLab, `sk-…`, Google, npm, JWT, private keys), `password=…`-style assignments, and the exact values of the bridge's secret environment variables.
  - Text is flushed only at whitespace, so a token is never split across two appends where the redactor could not recognise it.

  The agent still runs as your user, so with full tools it can read any file through the
  shell. Redaction keeps recognisable secrets out of Slack; it is not a sandbox.
- When an ACP agent asks for permission, the bridge grants only `allow_once`. It never
  grants `allow_always`, and it cancels the request if no allow option is offered.

## Run

Requires Node.js 24+, which runs the TypeScript directly with no build step.

```sh
npm ci
mkdir -p ~/.config/agent-bridge
cp deploy/config.example.json ~/.config/agent-bridge/config.json   # then edit
printf 'SLACK_BOT_TOKEN=xoxb-…\nSLACK_APP_TOKEN=xapp-…\n' > ~/.config/agent-bridge/env && chmod 600 ~/.config/agent-bridge/env
cp deploy/agent-bridge.service ~/.config/systemd/user/ && systemctl --user enable --now agent-bridge
```

The Slack app needs Socket Mode and these bot scopes: `app_mentions:read`, `chat:write`,
`channels:history`, `groups:history`, `im:history`, `im:read`, `im:write`, `mpim:history`.
It also needs the event subscriptions `app_mention`, `message.channels`, `message.groups` and `message.im`.

**Use a Slack app of its own.** With Socket Mode, Slack splits events across every
connection open for an app. If this bridge shares an app with another bot, such as
cc-connect, each message reaches only one of the two at random.

## Migrating from cc-connect

Stop agent-bridge first, then import cc-connect's cron jobs:

```sh
node scripts/migrate-cc-connect.ts --dry-run
node scripts/migrate-cc-connect.ts
```

The import maps cc-connect's fields as follows:

| cc-connect | agent-bridge |
|---|---|
| `slack:<channel>:<user>` session | that channel, owned by that user |
| `description` | schedule name |
| `exec` | an exec schedule |
| `silent` / `mute` | `silent` |
| `new_per_run` session mode | `fresh` |
| `reuse` session mode (the cc-connect default) | `continue` |
| `timeout_mins` | the schedule's timeout (default 30) |
| disabled job | paused schedule |

Running it again skips jobs it has already imported.

cc-connect's sessions are keyed per chat, not per thread, so old conversations do not
carry over. Scripts that read the bot token from `~/.cc-connect/config.toml` keep working
as long as that file stays.

## Tests

```sh
npm run typecheck
npm test              # unit tests: fake Slack, fake agents, a scripted ACP agent (~2 s)
scripts/with-slack-env.sh npm run e2e -- --channel "$SLACK_CHANNEL_ID" --owner "$SLACK_USER_ID"   # real Slack + real claude/omp, see below
```

`scripts/e2e.ts` runs against real Slack and real agents. It covers:

- a channel chat with Claude Code: tool card, context across turns, resume after `!release`, `!stop`
- an omp chat in the owner's DM, resumed after release
- an omp one-shot run
- exec and silent schedules, and a mention in a thread the bridge did not start
- an attachment the agent has to read
- in the concise display, two tool calls folded into one card
- the Claude and omp processes each running in an 8G systemd scope
- an Antigravity chat (tool card, context, resume after release) plus a one-shot run
- a schedule that fires on its own into the DM
- a continue-mode omp schedule run twice

Inbound events are injected into the router rather than received over Socket Mode,
because the bot app is shared with a running cc-connect. The bot posts each "user"
message as a labelled seed, and the checks read the thread back with
`conversations.replies`. At the end it posts a summary to the test channel.

## Layout

```
src/agents/    types.ts (bridge-side contract) · oar.ts (OAR runtimes, restricted mode, secret-path denies)
               acp.ts (ACP client) · memcap.ts (per-agent systemd scopes)
src/slack/     api.ts (Web API slice) · render.ts (turn → stream: concise card or verbose cards) · app.ts (Bolt Socket Mode)
src/core/      manager.ts (thread ↔ session) · binding.ts (turns, stall watchdog) · router.ts (access, commands, context)
               commands.ts · runner.ts (one-shot, headless) · attachments.ts · backfill.ts
src/sched/     scheduler.ts (croner, catch-up) · exec.ts
src/security/  redact.ts (outbound redaction)
src/store.ts   node:sqlite
```

## Telegram with OAR (Codex and Antigravity)

Use the Telegram entry point `src/telegram/main.ts` with Bun or Node 24+.
The bridge imports the selected OAR runtime on demand. Each turn owns a Codex
app-server or an Antigravity ACP session, disposed after the turn. SQLite keeps
native conversation IDs per chat, topic and provider. Existing CLI thread IDs
resume when the provider matches. The selected CLI must already be signed in.

Set `AGENT_BRIDGE_CONFIG` to a private JSON file and `AGENT_BRIDGE_TOKEN_FILE`
to a mode-0600 file containing the Telegram token. Use a dedicated database:

```json
{
  "ownerUserId": "12345678",
  "defaultCwd": "/path/to/workspace",
  "dbPath": "~/.local/share/agent-bridge/telegram.db",
  "cronCatchUp": "off",
  "telegram": { "model": "your-codex-model", "effort": "medium", "fullAccess": false }
}
```

Set `telegram.agent` to `codex` (default) or `antigravity` (`agy` is accepted).
The configured model and effort apply to that default provider. Optional
`telegram.providers.codex` and `telegram.providers.antigravity` objects can
set `model` and `effort` for each provider, including scheduled runs. Codex inherits
its native sandbox settings unless full access is requested. OAR's Antigravity
ACP implementation auto-approves tool requests, so this bridge requires
explicit `telegram.fullAccess: true` to use it.

Only the numeric owner can invoke agents. Private chats, forum topics, group
mentions, replies to the bot and slash commands are supported. The bot receives
only messages Telegram delivers under the group's privacy settings. Use
`/new`, `/ask`, `/html`, `/stop`, or `/cron`. Rich Markdown and HTML replies use
`sendRichMessage` with a plain-text fallback. Private chats support stoppable
generation drafts. Messages from bots, anonymous administrators and channels
are ignored. Agent processes receive an attachment sender on PATH compatible
with `cc-connect send --file` and `--image`. Set fullAccess only for an owner
who needs unrestricted tool execution.

Use the following commands in a DM or addressed to the bot in a group:

| Command | Behaviour |
| --- | --- |
| `/provider`, `/provider codex`, `/provider antigravity` | Show or switch the backend for this topic. Switching back resumes its own history. |
| `/model`, `/model MODEL_ID` | List live OAR model IDs or select one. |
| `/reasoning`, `/reasoning LEVEL` | List the selected model’s supported effort levels or set one. |
| `/new` | Clear this provider’s conversation in the current topic. |

Selections survive restarts. `/cron` shows the shared Telegram schedule settings. Use
`/cron set <provider> <model> [reasoning]` once for all current and future agent schedules.
Values are validated against the live model catalog before saving. Without a saved
selection, schedules use the configured Telegram defaults. Each new firing reads
the shared settings. Chat selections stay topic-specific, and shell jobs run directly.

Import while stopped using the original scheduler's timezone:

```sh
node scripts/migrate-cc-connect.ts --platform telegram --agent codex --cwd /path/to/workspace --timezone Etc/UTC
bun --smol src/telegram/main.ts
```

The importer keeps origin IDs and skips previously imported jobs. Verify target,
mode, expression, timezone and prompt before cutting over. A sample Linux unit
is in `deploy/agent-bridge-telegram.service`. Stop the previous poller before
starting this one. To test the real API without polling or running production jobs,
`bun --smol scripts/telegram-e2e.ts` dispatches a synthetic owner message,
resumes its real provider conversation and checks two real Telegram receipts.
