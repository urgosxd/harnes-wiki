#!/usr/bin/env bash
#
# The gate, in one executable file.
#
# ## Why everything lives here and not in the workflow
#
# A workflow that a person cannot run is documentation wearing a gate's clothes. Every
# command CI executes is in this script, so `bash scripts/ci.sh` on a laptop is the same
# gate as a failing check on a pull request — same images, same database, same
# assertions. The YAML only checks out the repository and calls this file.
#
# ## Why Docker for the tests as well as the images
#
# The runtime images deliberately omit the test toolchain (`npm ci --omit=dev`), so the
# tests run in dedicated `test` targets of the same Dockerfiles. That keeps CI and a
# laptop on one Node version, one lockfile and one set of images, and it means the
# Dockerfiles themselves are part of what this script proves.
#
# ## What it does NOT prove
#
# The live-model tier needs real Pi credentials, which CI does not have and must not
# fake: those tests skip, and `PI_AGENT_DIR` is pointed at a path that does not exist so
# the skip is a decision rather than an accident of the runner. Everything that only
# needs Postgres does run, and a missing database FAILS this script instead of quietly
# skipping the tier — that is what `CI_REQUIRE_DATABASE=1` is for.
#
# Usage, from anywhere in the repository:
#   bash scripts/ci.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# The compose project name is PINNED, not inferred.
#
# Docker derives it from the directory holding docker-compose.yml: `AgentDocumentor` on
# this machine, `harnes-wiki` under actions/checkout, because that is the repository's
# name. A network name read off that would work on exactly one checkout and then fail in
# CI with "no database answered" — an environmental bug reported as a database bug, on
# every push. Pinning the project makes the project, its containers and its network the
# same everywhere, which is the whole point of a script CI and a laptop share.
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-agentdocumentor}"
export COMPOSE_PROJECT_NAME

# The network name is DERIVED from compose itself — the whole name, not a prefix with a
# suffix this script guessed. Compose renders the final name it will create (`networks:`
# -> `name:`), so asking it beats assuming: rename the network key, set a different
# project, or deploy somewhere with its own project name, and this still points at the one
# compose will create. Anything else is the same assumption that cost a round already: a
# name that matches on one machine and times out on another.
compose_network_name() {
  docker compose config 2>/dev/null | awk '
    /^networks:[[:space:]]*$/ { inside = 1; next }
    inside && /^[^[:space:]]/ { inside = 0 }
    inside && /^[[:space:]]+name:[[:space:]]/ { print $2; found += 1 }
    END { if (found != 1) exit 1 }
  '
}
COMPOSE_NETWORK="${COMPOSE_NETWORK:-$(compose_network_name)}"
TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgres://agentdocumentor:agentdocumentor@postgres:5432/agentdocumentor}"
DB_WAIT_SECONDS="${DB_WAIT_SECONDS:-120}"

step() {
  printf '\n== %s ==\n' "$1"
}

fail() {
  printf '\nFAILED: %s\n' "$1" >&2
  exit 1
}

# Checked here, after `fail` exists: a derivation that produced nothing would leave the
# literal "_internal" and then time out with a message naming the wrong cause.
if [ -z "$COMPOSE_NETWORK" ]; then
  fail "could not derive the compose network name: docker-compose.yml must declare exactly one network"
fi

step "docker is usable"
docker info >/dev/null 2>&1 || fail "docker is not available; this script needs it so CI and a laptop agree"

step "build the production images (a broken Dockerfile fails the gate here)"
docker compose build || fail "docker compose build failed"

step "build the test images (dev dependencies the runtime image omits on purpose)"
docker build --target test -t agentdoc-server-test ./server || fail "server test image failed to build"
docker build --target test -t agentdoc-web-test ./web || fail "web test image failed to build"

step "database: start it and wait for a real query, not just a healthy container"
docker compose up -d postgres || fail "could not start postgres"

# The error from the last attempt is kept and printed on failure: a wrong network and a
# stale volume password both used to surface as "no database answered", which sends a
# reader looking in the wrong place.
LAST_DB_ERROR="$(mktemp)"
trap 'rm -f "$LAST_DB_ERROR"' EXIT

can_query_database() {
  docker run --rm --network "$COMPOSE_NETWORK" -e DATABASE_URL="$TEST_DATABASE_URL" agentdoc-server-test \
    node -e 'const pg = require("pg"); const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); c.connect().then(() => c.query("select 1")).then(() => { c.end(); process.exit(0); }).catch((e) => { console.error(e.message); process.exit(1); });' \
    >/dev/null 2>"$LAST_DB_ERROR"
}

deadline=$((SECONDS + DB_WAIT_SECONDS))
until can_query_database; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    printf 'last attempt said:\n%s\n' "$(tail -5 "$LAST_DB_ERROR" 2>/dev/null)" >&2
    fail "no database answered a query within ${DB_WAIT_SECONDS}s on network ${COMPOSE_NETWORK}; the Postgres tier would have been skipped, which in CI is a lie"
  fi
  sleep 2
done
printf 'database answered a query\n'

step "server: typecheck, then the suite with the database tier REQUIRED"
# `CI_REQUIRE_DATABASE` turns an unreachable database into a failure instead of a skip;
# `PI_AGENT_DIR` names a path that does not exist so the live-model tier skips by
# decision, and the summary says so.
# `test/` is excluded from every image on purpose (see the Dockerfile), so it is mounted
# read-only from the working tree: the tests that run are the checked-out ones.
docker run --rm --network "$COMPOSE_NETWORK" \
  -v "$ROOT/server/test:/app/test:ro" \
  -v "$ROOT:/repo:ro" \
  -e CI_REPO_ROOT=/repo \
  -e DATABASE_URL="$TEST_DATABASE_URL" \
  -e CI_REQUIRE_DATABASE=1 \
  -e PI_AGENT_DIR=/nonexistent-no-pi-credentials-on-purpose \
  agentdoc-server-test sh -c 'npx tsc --noEmit && npm test' \
  || fail "server typecheck or tests failed"

step "web: typecheck, tests, production build"
docker run --rm agentdoc-web-test sh -c 'npx tsc --noEmit && npx vitest run && npx vite build' \
  || fail "web typecheck, tests or build failed"

step "cleanup: stop the containers, keep the volumes"
# `down` without `-v`: this removes the containers and the network and leaves every
# volume alone. `-v` would delete the workspace volume too, which is exactly the kind of
# over-reach that had to be scoped by hand once already.
docker compose down >/dev/null 2>&1 || printf 'cleanup: nothing to stop\n'

step "done"
printf 'CI passed: production images built, server suite green with a real database,\n'
printf 'web suite and build green. The live-model tier skipped by design (no Pi credentials here).\n'
printf 'Volumes were left in place; `docker compose down -v` would remove them, including the workspace.\n'
