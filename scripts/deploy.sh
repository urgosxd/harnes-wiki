#!/usr/bin/env sh
#
# Deploy the production stack with one command, and refuse to deploy a broken one.
#
#   ./scripts/deploy.sh                          # validate, pull, up -d --wait
#   ./scripts/deploy.sh --check                  # validate only, touch nothing
#   ./scripts/deploy.sh --env-file /path/to/env  # use another env file
#
# Why this exists instead of a line in the README: this is the validated,
# healthcheck-gated path, not the only one. A manual
#
#   docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
#
# stays supported. What this script adds is the validation that runs BEFORE any
# docker command, plus `--wait` — the reason to prefer it, not exclusivity. The
# production path has four failure modes that are invisible until something is
# already running —
#
#   * `docker compose -f docker-compose.prod.yml up -d` reads the DEVELOPMENT `.env`
#     unless told otherwise, so a deployment could start with dev credentials;
#   * `POSTGRES_PASSWORD` is baked into the volume on the first initdb, so a
#     placeholder that survives the first `up` cannot be corrected in place;
#   * the server starts without `CHAT_API_KEY` and only fails at the first turn;
#   * `up -d` returns as soon as the containers are created, so "it started" says
#     nothing about whether the stack is healthy.
#
# Every check below runs BEFORE a single docker command in deploy mode, and `--check`
# runs them without touching docker or the filesystem at all.
#
# POSIX sh on purpose: this runs on a bare target host, where bash may not be.
set -eu

START_DIR=$(pwd)
MODE=deploy
ENV_FILE=""

usage() {
  cat <<'USAGE'
Usage: ./scripts/deploy.sh [--check] [--env-file <path>]

  (no flags)            Validate, pull the images, then run
                        `docker compose ... up -d --wait` (healthcheck-gated).

  --check               Validate only. Prints what WOULD happen and exits 0 or 1.
                        Runs no docker command and creates no file.

  --env-file <path>     Read variables from <path> instead of .env.prod in the
                        repository root.

  -h, --help            This text.

Exit status: 0 success, 1 validation or deployment failure, 2 usage error.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE=check ;;
    --env-file)
      if [ $# -lt 2 ]; then
        printf 'error: --env-file needs a path\n' >&2
        exit 2
      fi
      ENV_FILE=$2
      shift
      ;;
    --env-file=*) ENV_FILE=${1#--env-file=} ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf 'error: unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
COMPOSE_FILE="$ROOT/docker-compose.prod.yml"
TEMPLATE="$ROOT/deploy/env.prod.example"

# A relative --env-file is relative to where the operator stood, not to the
# repository root this script later changes into.
if [ -n "$ENV_FILE" ]; then
  case "$ENV_FILE" in
    /*) : ;;
    *) ENV_FILE="$START_DIR/$ENV_FILE" ;;
  esac
else
  ENV_FILE="$ROOT/.env.prod"
fi

if [ ! -f "$COMPOSE_FILE" ]; then
  printf 'error: %s is missing; run this script from a checkout of the repository\n' "$COMPOSE_FILE" >&2
  exit 1
fi

# --- output helpers ---------------------------------------------------------
#
# Problems go to stderr and are counted; nothing is deployed while the count is
# non-zero. No message ever prints a value that could be a secret: variables are
# named, never echoed.
problems=0

problem() {
  printf 'error: %s\n' "$1" >&2
  problems=$((problems + 1))
}

warn() {
  printf 'warning: %s\n' "$1" >&2
}

note() {
  printf '%s\n' "$1"
}

# --- reading the env file ---------------------------------------------------
#
# The file is READ, never sourced: it is data, and sourcing it would execute
# whatever a paste left in it. Last assignment wins, matching compose's own
# behaviour for a duplicated key.
value_of() {
  [ -f "$ENV_FILE" ] || return 0
  _line=$(
    sed -n 's/^[[:space:]]*'"$1"'[[:space:]]*=[[:space:]]*//p' "$ENV_FILE" \
    | tail -n 1 \
    | tr -d '\r'
  )
  case "$_line" in
    '"'*'"' | "'"*"'")
      # A quoted value is taken verbatim, including any '#' inside it.
      _line=${_line#?}
      _line=${_line%?}
      ;;
    *)
      # Compose drops an inline comment from an UNQUOTED value, so a `VERSION=0.1.0
      # # bump` must not be read here as a tag with a comment glued to it.
      _line=${_line%%[[:space:]]#*}
      ;;
  esac
  printf '%s' "$_line" | sed -e 's/[[:space:]]*$//'
}

# Compose interpolates from the shell environment FIRST and from --env-file second,
# so an exported value silently wins over the file. Mirroring that here is the whole
# point: validating the file while deploying something else is worse than no check.
effective() {
  _eff=$(printenv "$1" 2>/dev/null || true)
  if [ -n "$_eff" ]; then
    printf '%s' "$_eff"
  else
    value_of "$1"
  fi
}

# The template ships placeholders. Deploying them is the one mistake that cannot be
# fixed in place, so it is a failure rather than a warning.
looks_like_placeholder() {
  case "$(printf '%s' "$1" | tr 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' 'abcdefghijklmnopqrstuvwxyz')" in
    *change_me* | *change-me* | *changeme* | *replace* | *example.com* | *your-*) return 0 ;;
    *) return 1 ;;
  esac
}

# config.ts parses these as http(s) ORIGINS and throws on anything else at startup.
check_origin() {
  _name=$1
  _val=$2
  [ -n "$_val" ] || return 0
  case "$_val" in
    http://?* | https://?*) : ;;
    *)
      problem "$_name must be an absolute http(s) URL such as http://host:8080; server/src/config.ts aborts at startup on anything else."
      return 0
      ;;
  esac
  case "$_val" in
    *'?'* | *'#'*)
      problem "$_name must be an origin with no query or fragment; server/src/config.ts aborts at startup otherwise."
      return 0
      ;;
  esac
  _rest=${_val#*://}
  case "$_rest" in
    */*)
      problem "$_name must be an origin with no path; server/src/config.ts aborts at startup otherwise."
      return 0
      ;;
  esac
  case "$_rest" in
    0.0.0.0 | 0.0.0.0:*)
      problem "$_name must be a reachable address, not 0.0.0.0: that is a bind address, so no service accepts it as a request host."
      ;;
  esac
}

# The host URL comes from the compose file, not from a constant here: a script that
# prints a port the deployment does not publish is a lie with a timestamp on it.
web_url() {
  _mapping=$(
    sed -n '/^  web:/,/^  [a-zA-Z]/p' "$COMPOSE_FILE" |
      grep -o '127\.0\.0\.1:[0-9]*:[0-9]*' |
      head -n 1
  )
  if [ -z "$_mapping" ]; then
    printf '%s' "(not derived: see the web service 'ports' in docker-compose.prod.yml)"
    return 0
  fi
  _host_port=${_mapping#127.0.0.1:}
  _host_port=${_host_port%%:*}
  printf 'http://127.0.0.1:%s/' "$_host_port"
}

# --- 1. the env file must exist --------------------------------------------
if [ ! -f "$ENV_FILE" ]; then
  if [ "$MODE" = check ]; then
    printf 'error: %s does not exist.\n' "$ENV_FILE" >&2
    printf '       Start from the template: cp deploy/env.prod.example %s && chmod 600 %s\n' "$ENV_FILE" "$ENV_FILE" >&2
    printf '       (template: %s)\n' "$TEMPLATE" >&2
    exit 1
  fi

  if [ ! -f "$TEMPLATE" ]; then
    printf 'error: %s is missing and there is no template at %s to copy.\n' "$ENV_FILE" "$TEMPLATE" >&2
    exit 1
  fi
  cp "$TEMPLATE" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  cat >&2 <<MESSAGE

################################################################################
#  STOPPED: NOTHING WAS DEPLOYED.
#
#  $ENV_FILE did not exist, so the template was copied there:

        $TEMPLATE
     -> $ENV_FILE

#  That file is a TEMPLATE FULL OF PLACEHOLDERS and it MUST be edited first.
#
#  Two of them are not recoverable by editing later:
#    * POSTGRES_PASSWORD is applied on the volume's FIRST initdb only. A dummy
#      value that reaches the first 'up' stays in the database, and the server
#      can then never connect to its own volume.
#    * CHAT_API_KEY is rejected by the provider, so every turn fails with
#      "No API key found for the selected model" while the stack looks healthy.
#
#  Edit it now, then run this script again:

        \$EDITOR $ENV_FILE     # set POSTGRES_PASSWORD (openssl rand -hex 24)
        ./scripts/deploy.sh --check
        ./scripts/deploy.sh
################################################################################

MESSAGE
  exit 1
fi

# --- 2. read the variables --------------------------------------------------
#
# `docker compose --env-file` never overrides the shell environment, so the value
# that reaches the container is the exported one when both exist. Validate that.
VERSION=$(effective VERSION)
POSTGRES_PASSWORD=$(effective POSTGRES_PASSWORD)
REGISTRY=$(effective REGISTRY)
CHAT_API_KEY=$(effective CHAT_API_KEY)
CHAT_PROVIDER=$(effective CHAT_PROVIDER)
CHAT_MODEL=$(effective CHAT_MODEL)
CHAT_THINKING_LEVEL=$(effective CHAT_THINKING_LEVEL)
PI_WORKSPACE_DIR=$(effective PI_WORKSPACE_DIR)
PI_AGENT_DIR=$(effective PI_AGENT_DIR)
PI_AGENT_CONFIG_MODE=$(effective PI_AGENT_CONFIG_MODE)
AUTH_MODE=$(effective AUTH_MODE)
INGEST_API_BASE_URL=$(effective INGEST_API_BASE_URL)
PUBLIC_BASE_URL=$(effective PUBLIC_BASE_URL)

# --- 3. variables the COMPOSE FILE refuses to start without ----------------
#
# docker-compose.prod.yml spells them `${VERSION:?}` and `${POSTGRES_PASSWORD:?}`,
# so these are measured, not a policy this script invented.
if [ -z "$VERSION" ]; then
  problem "VERSION is not set. It names the image tag to deploy and docker-compose.prod.yml has no default for it (e.g. VERSION=0.1.0)."
fi

if [ -z "$POSTGRES_PASSWORD" ]; then
  problem "POSTGRES_PASSWORD is not set. docker-compose.prod.yml refuses to start without it."
elif looks_like_placeholder "$POSTGRES_PASSWORD"; then
  problem "POSTGRES_PASSWORD still holds a template placeholder. Generate a real one: openssl rand -hex 24"
else
  case "$POSTGRES_PASSWORD" in
    *'@'* | *':'* | *'/'* | *'#'* | *'?'* | *'%'* | *' '*)
      problem "POSTGRES_PASSWORD contains a character that breaks DATABASE_URL when it is interpolated (@ : / # ? % or space). Use hex only: openssl rand -hex 24"
      ;;
  esac
fi

# REGISTRY is OPTIONAL in the compose file (`${REGISTRY:+${REGISTRY}/}`), so an
# empty value is a supported deployment, not a mistake: it selects the local images.
if [ -z "$REGISTRY" ]; then
  note "registry:  (empty) -> local images agentdocumentor-server:$VERSION and agentdocumentor-web:$VERSION must already exist on this host"
else
  case "$REGISTRY" in
    */)
      problem "REGISTRY must not end with '/': docker-compose.prod.yml already adds the separator (\${REGISTRY}/agentdocumentor-server:\${VERSION})."
      ;;
  esac
fi

# --- 4. variables the SERVER refuses to start, or starts broken, without ---
#
# server/src/config.ts calls required() for PI_WORKSPACE_DIR, CHAT_PROVIDER and
# CHAT_MODEL: a missing one throws ConfigError and the process exits. The compose
# file supplies all three itself — PI_WORKSPACE_DIR literally (/data/workspace) and
# the other two with defaults — so they are NOT env-file requirements here. What can
# go wrong is an override that silently does nothing, which is named as a warning.
if [ -z "$CHAT_API_KEY" ]; then
  problem "CHAT_API_KEY is not set. The server would start and then fail every single turn with 'No API key found for the selected model'."
elif looks_like_placeholder "$CHAT_API_KEY"; then
  problem "CHAT_API_KEY still holds a template placeholder. Paste the provider key from CHAT_PROVIDER=$CHAT_PROVIDER."
fi

if [ -n "$PI_WORKSPACE_DIR" ] && [ "$PI_WORKSPACE_DIR" != "/data/workspace" ]; then
  warn "PI_WORKSPACE_DIR is ignored: docker-compose.prod.yml pins it to /data/workspace (the agentdoc-workspace volume)."
fi
if [ -n "$PI_AGENT_DIR" ]; then
  warn "PI_AGENT_DIR is ignored in production: PI_AGENT_CONFIG_MODE=generate makes the server write its own models.json from the CHAT_* variables."
fi

# config.ts aborts when the mode is anything but `generate` AND PI_AGENT_DIR is
# empty. The compose file pins `generate`, so that abort is unreachable through this
# path — the failure would have to come from an override that cannot take effect.
if [ -n "$PI_AGENT_CONFIG_MODE" ] && [ "$PI_AGENT_CONFIG_MODE" != "generate" ]; then
  warn "PI_AGENT_CONFIG_MODE is ignored: docker-compose.prod.yml pins it to generate (which is what lets the server start with no PI_AGENT_DIR)."
fi

if [ -n "$CHAT_THINKING_LEVEL" ]; then
  case "$CHAT_THINKING_LEVEL" in
    off | minimal | low | medium | high | xhigh | max) : ;;
    *)
      problem "CHAT_THINKING_LEVEL must be one of off, minimal, low, medium, high, xhigh, max; server/src/config.ts aborts at startup otherwise."
      ;;
  esac
fi

# --- 5. malformed origins (startup abort, not a degradation) ---------------
check_origin PUBLIC_BASE_URL "$PUBLIC_BASE_URL"
check_origin INGEST_API_BASE_URL "$INGEST_API_BASE_URL"

# --- 6. WARNINGS: the stack runs, but something is worse than it looks -----
if [ -z "$INGEST_API_BASE_URL" ]; then
  warn "INGEST_API_BASE_URL is empty: uploads keep working, but ingest-by-document answers 503 ingest_not_configured."
fi
if [ -z "$PUBLIC_BASE_URL" ]; then
  warn "PUBLIC_BASE_URL is empty: upload-backed ingests are disabled, because there is no origin to hand to the ingest service."
fi
case "$AUTH_MODE" in
  open | '')
    warn "AUTH_MODE=open: the name in the link IS the identity and there is no secret behind it. Put TLS and network restrictions in front, or use AUTH_MODE=roster with CHAT_USERS."
    ;;
esac

# --- 7. verdict -------------------------------------------------------------
if [ "$problems" -gt 0 ]; then
  printf '\n%d problem(s) in %s. Nothing was deployed.\n' "$problems" "$ENV_FILE" >&2
  printf 'Fix them, then re-run: ./scripts/deploy.sh --check\n' >&2
  exit 1
fi

# One place builds the command, so execution never depends on word splitting: an env
# file path may contain a space, and `$HINT pull` would then deploy the wrong thing.
compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

COMPOSE_HINT="docker compose --env-file $ENV_FILE -f $COMPOSE_FILE"
URL=$(web_url)
if [ -n "$REGISTRY" ]; then
  SERVER_IMAGE="$REGISTRY/agentdocumentor-server:$VERSION"
  WEB_IMAGE="$REGISTRY/agentdocumentor-web:$VERSION"
else
  SERVER_IMAGE="agentdocumentor-server:$VERSION"
  WEB_IMAGE="agentdocumentor-web:$VERSION"
fi

if [ "$MODE" = check ]; then
  cat <<CHECK
check: OK — $ENV_FILE is complete enough to deploy.

  images:   $SERVER_IMAGE
            $WEB_IMAGE
  registry: ${REGISTRY:-(empty: local images, no pull from a registry)}
  version:  $VERSION

  supplied by docker-compose.prod.yml (an entry in the env file cannot change them):
            PI_WORKSPACE_DIR=/data/workspace
            PI_AGENT_CONFIG_MODE=generate
            CHAT_PROVIDER/CHAT_MODEL default to synthetic / syn:large:text
            DATABASE_URL is built from POSTGRES_PASSWORD (not shown)

  would run:
            $COMPOSE_HINT pull
            $COMPOSE_HINT up -d --wait

  web url:  $URL
  nothing was pulled, started or written.
CHECK
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  printf 'error: docker is not on PATH; this host cannot deploy the stack.\n' >&2
  exit 1
fi

# --- 8. deploy --------------------------------------------------------------
printf '==> pulling %s and %s\n' "$SERVER_IMAGE" "$WEB_IMAGE"
pull_status=0
compose pull || pull_status=$?

if [ "$pull_status" -ne 0 ]; then
  # A pull failure is tolerable ONLY when every image is already present locally,
  # which is exactly the deployment compose supports with an empty REGISTRY. Saying
  # which images are being used is the difference between a degraded deploy and a
  # silent guess.
  missing=""
  for ref in "$SERVER_IMAGE" "$WEB_IMAGE"; do
    if ! docker image inspect "$ref" >/dev/null 2>&1; then
      missing="$missing $ref"
    fi
  done
  if [ -n "$missing" ]; then
    printf 'error: pull failed (exit %s) and these images are not present locally:%s\n' "$pull_status" "$missing" >&2
    printf '       Build and publish them first: see the multi-arch section of README.md.\n' >&2
    exit 1
  fi
  warn "pull failed (exit $pull_status), but both images exist locally; deploying those: $SERVER_IMAGE, $WEB_IMAGE"
fi

printf '==> starting the stack and waiting for healthchecks (--wait)\n'
up_status=0
compose up -d --wait || up_status=$?

if [ "$up_status" -ne 0 ]; then
  printf '\nerror: docker compose up failed with exit status %s. Last 40 log lines:\n' "$up_status" >&2
  compose logs --tail=40 || true
  printf '\nInspect further with: %s logs -f\n' "$COMPOSE_HINT" >&2
  exit "$up_status"
fi

cat <<DONE

==> deployed $VERSION. Every service reported healthy.

  web url:  $URL

  follow-ups:
            $COMPOSE_HINT logs -f server
            $COMPOSE_HINT down
DONE
