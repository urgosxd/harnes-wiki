#!/usr/bin/env bash
#
# Environment for running the agent server locally (development).
#
# Source it, do not execute it:
#     source scripts/dev-env.sh
#
# It mirrors what the container generates for itself, so `npm start` in ./server
# behaves the same as the dockerised service. Values are derived from your Pi
# config where possible instead of being typed by hand: the api type is not
# guessable ("synthetic" is a provider name, not an API type, and using it fails at
# the first turn with "No API provider registered for api").

export CHAT_PROVIDER="${CHAT_PROVIDER:-synthetic}"
export CHAT_MODEL="${CHAT_MODEL:-syn:large:text}"
export CHAT_THINKING_LEVEL="${CHAT_THINKING_LEVEL:-medium}"

HOST_MODELS="${PI_HOST_MODELS:-$HOME/.pi/agent/models.json}"

if [ -f "$HOST_MODELS" ]; then
  # key, api type and base URL, in that order, from the provider's own entry.
  _pi_values="$(PROVIDER="$CHAT_PROVIDER" MODELS="$HOST_MODELS" node -e '
    const { readFileSync } = require("node:fs");
    try {
      const doc = JSON.parse(readFileSync(process.env.MODELS, "utf8"));
      const p = doc?.providers?.[process.env.PROVIDER];
      if (!p || typeof p.apiKey !== "string" || !p.apiKey.trim()) process.exit(1);
      process.stdout.write([p.apiKey.trim(), p.api ?? "", p.baseUrl ?? ""].join("\n"));
    } catch {
      process.exit(1);
    }
  ')" || true

  if [ -n "${_pi_values:-}" ]; then
    export CHAT_API_KEY="${CHAT_API_KEY:-$(printf '%s' "$_pi_values" | sed -n 1p)}"
    export CHAT_API="${CHAT_API:-$(printf '%s' "$_pi_values" | sed -n 2p)}"
    export CHAT_BASE_URL="${CHAT_BASE_URL:-$(printf '%s' "$_pi_values" | sed -n 3p)}"
  fi
  unset _pi_values
fi

# Documented defaults, used when the host config did not provide them.
export CHAT_API="${CHAT_API:-openai-completions}"
export CHAT_BASE_URL="${CHAT_BASE_URL:-https://api.synthetic.new/openai/v1}"
export CHAT_CONTEXT_WINDOW="${CHAT_CONTEXT_WINDOW:-524288}"
export CHAT_MAX_TOKENS="${CHAT_MAX_TOKENS:-65536}"
export CHAT_REASONING="${CHAT_REASONING:-true}"

# The server writes its own models.json from the CHAT_* values above.
export PI_AGENT_CONFIG_MODE="${PI_AGENT_CONFIG_MODE:-generate}"
# A scratch workspace, never a real project: Pi appends a <cwd> section to the
# system prompt, so this must be a neutral directory.
export PI_WORKSPACE_DIR="${PI_WORKSPACE_DIR:-/tmp/agentdoc-dev-workspace}"

export DATABASE_URL="${DATABASE_URL:-postgres://agentdocumentor:agentdocumentor@127.0.0.1:5432/agentdocumentor}"
# Identity is the name the client claims: there is no secret, so there is no roster
# to generate and no token file to keep. `?user=alice` IS alice. Stated here rather
# than assumed, because a local server that looks authenticated but is not is the
# kind of thing that gets exposed by accident.
export AUTH_MODE="${AUTH_MODE:-open}"
export PORT="${PORT:-8080}"
export LOG_LEVEL="${LOG_LEVEL:-info}"

mkdir -p "$PI_WORKSPACE_DIR"

if [ -z "${CHAT_API_KEY:-}" ]; then
  echo "warning: CHAT_API_KEY is empty; the server will refuse to start." >&2
  echo "         set it explicitly, or keep it in $HOST_MODELS" >&2
fi
