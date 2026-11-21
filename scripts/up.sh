#!/usr/bin/env bash
#
# Start the stack without exporting anything by hand.
#
# The server container builds its own Pi configuration from environment variables
# and mounts nothing from the host. The provider key still has to come from
# somewhere, and re-typing it is a poor experience, so this script reads the key
# from an existing ~/.pi/agent/models.json and passes it as an environment
# variable. The file itself is NOT mounted: only the key travels, in memory.
#
# Any variable already set in your shell wins, so this is safe to use alongside a
# hand-written .env or a CI secret.
set -euo pipefail

cd "$(dirname "$0")/.."

HOST_MODELS="${PI_HOST_MODELS:-$HOME/.pi/agent/models.json}"
PROVIDER="${CHAT_PROVIDER:-synthetic}"

if [ -z "${CHAT_API_KEY:-}" ]; then
  if [ -f "$HOST_MODELS" ]; then
    # Read the key AND the api type AND the base URL from the host config. The api
    # value is not guessable: "synthetic" is a provider name, not an API type, and
    # using it fails at the first turn with "No API provider registered for api".
    read -r CHAT_API_KEY CHAT_API_HOST CHAT_BASE_URL_HOST <<EOF2
$(PROVIDER="$PROVIDER" MODELS="$HOST_MODELS" node -e '
      const { readFileSync } = require("node:fs");
      try {
        const doc = JSON.parse(readFileSync(process.env.MODELS, "utf8"));
        const p = doc?.providers?.[process.env.PROVIDER];
        if (!p || typeof p.apiKey !== "string" || !p.apiKey.trim()) process.exit(1);
        process.stdout.write([p.apiKey.trim(), p.api ?? "", p.baseUrl ?? ""].join(" "));
      } catch {
        process.exit(1);
      }
    ')
EOF2
    CHAT_API_HOST="${CHAT_API_HOST:-}"
    CHAT_BASE_URL_HOST="${CHAT_BASE_URL_HOST:-}"
  fi
fi

if [ -z "${CHAT_API_KEY:-}" ]; then
  cat >&2 <<'MESSAGE'
No provider key found.

Either set it explicitly:

    CHAT_API_KEY=sk-... ./scripts/up.sh

or keep it in ~/.pi/agent/models.json, where this script looks first. The key is
passed to the container as an environment variable; no host directory is mounted.
MESSAGE
  exit 1
fi

# Prefer what the host config declares; fall back only when it said nothing.
if [ -z "${CHAT_API:-}" ] && [ -n "${CHAT_API_HOST:-}" ]; then
  CHAT_API="$CHAT_API_HOST"
fi
if [ -z "${CHAT_BASE_URL:-}" ] && [ -n "${CHAT_BASE_URL_HOST:-}" ]; then
  CHAT_BASE_URL="$CHAT_BASE_URL_HOST"
fi
if [ "$PROVIDER" = "synthetic" ] && [ -z "${CHAT_BASE_URL:-}" ]; then
  CHAT_BASE_URL="https://api.synthetic.new/openai/v1"
fi

export CHAT_API_KEY CHAT_PROVIDER="$PROVIDER"
export CHAT_BASE_URL="${CHAT_BASE_URL:-}"
export CHAT_API="${CHAT_API:-openai-completions}"

# Identity is a login. The default mode is `password`: a person opens the app and signs
# in with their own user and password, and the server keeps an HttpOnly session cookie.
#
# The link only chooses the Stack; it signs nobody in:
#
#     http://localhost:8088/?stackId=<stack-id>
#
# `?user=` and `?token=` are ignored. The two accounts a fresh database gets are `alice`
# and `bob`, and their passwords come from DEFAULT_USERS ("alice:<password>,bob:<password>"). When it
# is unset they are generated once, at the first boot, and printed in the server log — the
# log stream is sensitive exactly once, so capture it now:
#
#     docker compose logs server | grep 'generated password'
#
# `USERS` is gone with the credential link it fed: it used to decide which `?user=`
# links this script printed, and accounts now come from the database, not from a shell
# variable. The legacy modes (`open`, `shared-token`, `roster`) still work for tests and
# are selected only by setting AUTH_MODE explicitly.
export AUTH_MODE="${AUTH_MODE:-password}"

echo "provider:  $PROVIDER"
echo "api:       ${CHAT_API}"
echo "model:     ${CHAT_MODEL:-syn:large:text}"
echo "key:       ${CHAT_API_KEY:0:8}... (passed as an environment variable)"
echo "auth mode: ${AUTH_MODE}"
case "$AUTH_MODE" in
  password) echo "           (sign in with a user and a password; the seat is an account, not a link)" ;;
  open) echo "           (LEGACY, no authentication: the name in the header IS the identity)" ;;
  *) echo "           (LEGACY mode: see the Identity section of README.md)" ;;
esac

# Only pass these when they have a value, so the compose defaults apply.
if [ -z "$CHAT_BASE_URL" ]; then unset CHAT_BASE_URL; fi

docker compose up -d --build "$@"

echo
echo "Waiting for the stack to become healthy..."
for _ in $(seq 1 60); do
  server="$(docker inspect --format '{{.State.Health.Status}}' agentdoc-server 2>/dev/null || echo starting)"
  web="$(docker inspect --format '{{.State.Health.Status}}' agentdoc-web 2>/dev/null || echo starting)"
  if [ "$server" = "healthy" ] && [ "$web" = "healthy" ]; then
    echo
    echo "The app is at http://localhost:8088/"
    echo
    echo "Sign in with an account from the database. A fresh one gets two: alice, bob."
    if [ -z "${DEFAULT_USERS:-}" ]; then
      echo "  (passwords were generated at the first boot and printed once — this log line:"
      echo "   docker compose logs server 2>&1 | grep 'generated password')"
    fi
    echo
    echo "To open a Stack, keep the id in the URL — it chooses the Stack, it does not sign you in:"
    echo "  http://localhost:8088/?stackId=<stack-id>"
    echo "  (?user= and ?token= are ignored: identity is your account, not the URL.)"
    exit 0
  fi
  sleep 2
done

echo "The stack did not become healthy in time. Inspect it with:" >&2
echo "    docker compose logs --tail 40 server" >&2
exit 1
