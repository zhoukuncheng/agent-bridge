# agent-bridge

Run local coding agents from Slack. Every agent session lives in its own Slack thread.
Answers stream into the thread as they are written, and each tool call shows up as a
task card while it runs. One-shot runs and scheduled runs are supported too.

The first version supports **Claude Code** and **omp** (Oh My Pi).

- **Claude Code** runs through [`@botiverse/oar`](https://github.com/botiverse/oar),
  which drives `claude -p` stream-json. OAR tracks new CLI releases, so picking up new
  native features is mostly a dependency bump. Codex, Pi and Antigravity are one config
  entry away (`{"kind": "oar", "runtime": "codex"}`), but they have not been tested here yet.
- **omp** runs through a small built-in [ACP](https://agentclientprotocol.com) client
  (`omp acp`). OAR's Pi runtime refuses omp's version string. Any other ACP agent can
  use the same `"kind": "acp"` entry.

## How it behaves

| You do | The bridge does |
|---|---|
| Mention the bot in a channel, or DM it | Starts a session (default agent). It posts a header in the thread, then streams the answer |
| Reply in that thread (no mention needed) | Continues the same session. A reply sent while a turn is running is steered into it (Claude) or queued (omp) |
| `!chat --agent omp [--model M] [--cwd DIR] <prompt>` | Starts a session with a specific agent, model or working directory |
| `!run [--agent A] [--timeout MIN] <prompt>` | Runs a one-shot task, then frees the process. Replying in the thread resumes it |
| `!cron add "<expr>" [--agent A] [--channel here\|dm\|#chan] [--mode fresh\|continue] [--tz TZ] <prompt>` | Adds a schedule. The expression has 5 fields, or 6 with seconds. `fresh` opens a new thread for every run; `continue` keeps one thread and resumes its session |
| `!cron list` · `run <id>` · `pause <id>` · `resume <id>` · `rm <id>` | Manages schedules |
| `!stop` · `!status` · `!release` (inside a thread) | Interrupts the turn · shows session info · frees the process (the next reply resumes it) |
| `!help` | Shows the command list |

How replies look:

- Answers use Slack's native streaming API (`chat.startStream`, `chat.appendStream`, `chat.stopStream`).
- Tool calls render as timeline `task_update` cards.
- A long answer rolls over into a new message.
- If streaming fails, the bridge falls back to `chat.postMessage` plus `chat.update`.
- Every turn ends with a footer: outcome, duration, model, context use and cost where the agent reports them.

Sessions and resources:

- Sessions are keyed by `(channel, thread_ts)` and stored in SQLite.
- A session idle for `idleMinutes` is disposed. So is the least recently used idle
  session when `maxLiveSessions` is reached. The next message in its thread resumes it
  from the stored session id.
- Scheduled runs are skipped while the previous run of the same schedule is still going.
  Runs missed while the bridge was down are not replayed.

Agents run unattended with their own default permissions:

- OAR starts Claude with bypassed permission prompts.
- The ACP client approves `session/request_permission` with the first "allow" option.

Unattended means:

- When an ACP agent asks for permission, the bridge grants only `allow_once`. It never
  grants `allow_always`, and it cancels the request if no allow option is offered.
- Agent processes do not inherit `SLACK_BOT_TOKEN` or `SLACK_APP_TOKEN`.
- Only `allowUsers` can drive the bridge. Messages from anyone else are ignored without a reply.

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

## Tests

```sh
npm run typecheck
npm test              # unit tests: fake Slack, fake agents, a scripted ACP agent (~2 s)
scripts/with-slack-env.sh npm run e2e   # real Slack + real claude/omp, see below
```

`scripts/e2e.ts` runs against real Slack and real agents. It covers:

- a channel chat with Claude Code: tool card, context across turns, resume after `!release`, `!stop`
- an omp chat in the owner's DM, resumed after release
- an omp one-shot run
- a schedule that fires on its own into the DM
- a continue-mode omp schedule run twice

Inbound events are injected into the router rather than received over Socket Mode,
because the bot app is shared with a running cc-connect. The bot posts each "user"
message as a labelled seed, and the checks read the thread back with
`conversations.replies`. At the end it posts a summary to the test channel.

## Layout

```
src/agents/   types.ts (bridge-side contract) · oar.ts (OAR runtimes) · acp.ts (ACP client)
src/slack/    api.ts (Web API slice) · render.ts (turn → stream/task cards) · app.ts (Bolt Socket Mode)
src/core/     manager.ts (thread ↔ session) · binding.ts · router.ts · commands.ts · runner.ts (one-shot)
src/sched/    scheduler.ts (croner)
src/store.ts  node:sqlite
```
