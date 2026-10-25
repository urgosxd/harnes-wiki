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
    CHAT_API_KEY="$(PROVIDER="$PROVIDER" MODELS="$HOST_MODELS" node -e '
      const { readFileSync } = require("node:fs");
      try {
        const doc = JSON.parse(readFileSync(process.env.MODELS, "utf8"));
        const provider = doc?.providers?.[process.env.PROVIDER];
        const key = provider?.apiKey;
        if (typeof key === "string" && key.trim()) {
          process.stdout.write(key.trim());
        } else {
          process.exit(1);
        }
      } catch {
        process.exit(1);
      }
    ')" || true
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

# Keep the base URL and api type aligned with the provider actually used.
if [ "$PROVIDER" = "synthetic" ] && [ -z "${CHAT_BASE_URL:-}" ]; then
  CHAT_BASE_URL="https://api.synthetic.new/openai/v1"
fi

export CHAT_API_KEY CHAT_PROVIDER="$PROVIDER"
export CHAT_BASE_URL="${CHAT_BASE_URL:-}"
export DEV_AUTH_TOKEN="${DEV_AUTH_TOKEN:-dev}"

echo "provider: $PROVIDER"
echo "model:    ${CHAT_MODEL:-syn:large:text}"
echo "key:      ${CHAT_API_KEY:0:8}... (passed as an environment variable)"

# Only pass CHAT_BASE_URL when it has a value, so the compose default applies.
if [ -z "$CHAT_BASE_URL" ]; then
  unset CHAT_BASE_URL
fi

docker compose up -d --build "$@"

echo
echo "Waiting for the stack to become healthy..."
for _ in $(seq 1 60); do
  server="$(docker inspect --format '{{.State.Health.Status}}' agentdoc-server 2>/dev/null || echo starting)"
  web="$(docker inspect --format '{{.State.Health.Status}}' agentdoc-web 2>/dev/null || echo starting)"
  if [ "$server" = "healthy" ] && [ "$web" = "healthy" ]; then
    echo
    echo "Ready:  http://localhost:8088/?token=${DEV_AUTH_TOKEN}&user=alice"
    exit 0
  fi
  sleep 2
done

echo "The stack did not become healthy in time. Inspect it with:" >&2
echo "    docker compose logs --tail 40 server" >&2
exit 1
