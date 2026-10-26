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
# Two users with distinct secrets. Generated once per machine and kept in a local
# file so the same links keep working across restarts: the token IS the identity.
USERS_FILE=".chat-users"
if [ -z "${CHAT_USERS:-}" ]; then
  if [ -f "$USERS_FILE" ]; then
    CHAT_USERS="$(cat "$USERS_FILE")"
  else
    gen() { node -e 'process.stdout.write(require("node:crypto").randomBytes(12).toString("hex"))'; }
    CHAT_USERS="alice:$(gen),bob:$(gen)"
    printf '%s' "$CHAT_USERS" > "$USERS_FILE"
    chmod 600 "$USERS_FILE"
    echo "generated two user tokens in $USERS_FILE (keep the links private)"
  fi
fi
export CHAT_USERS

echo "provider: $PROVIDER"
echo "api:      ${CHAT_API}"
echo "model:    ${CHAT_MODEL:-syn:large:text}"
echo "key:      ${CHAT_API_KEY:0:8}... (passed as an environment variable)"

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
    echo "Links (each user has their own token):"
    # A here-string, not a pipe: inside a pipeline the loop runs in a subshell and
    # only the first line survives when combined with `read`.
    while IFS=: read -r id token; do
      if [ -n "$id" ]; then
        echo "  ${id}:  http://localhost:8088/?user=${id}&token=${token}"
      fi
    done <<< "$(printf '%s' "$CHAT_USERS" | tr ',' '\n')"
    exit 0
  fi
  sleep 2
done

echo "The stack did not become healthy in time. Inspect it with:" >&2
echo "    docker compose logs --tail 40 server" >&2
exit 1
