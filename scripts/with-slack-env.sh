#!/usr/bin/env bash
# Run a command with the Slack bot credentials from the cc-connect config in the environment.
set -euo pipefail
eval "$(python3 - <<'PY'
import tomllib, os, shlex
c = tomllib.load(open(os.path.expanduser("~/.cc-connect/config.toml"), "rb"))
o = next(p["options"] for pr in c["projects"] for p in pr.get("platforms", []) if p.get("type") == "slack")
print("export SLACK_BOT_TOKEN=" + shlex.quote(o["bot_token"]))
print("export SLACK_APP_TOKEN=" + shlex.quote(o["app_token"]))
PY
)"
exec "$@"
