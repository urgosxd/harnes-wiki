#!/bin/sh
# A named volume is created owned by root, but the server runs as `node`. Rather
# than requiring the host to chown a Docker-internal path (or running the server as
# root), take ownership of the writable volume here and drop privileges.
#
# Only the writable volumes are touched: the data volume (owned by `node` below) and the
# skills volume (seeded below). The agent directory stays a read-only mount.
#
# ## Seeding the skills volume
#
# Production mounts a named volume over `<workspace>/.pi/skills`, so on a first boot
# that directory is EMPTY — which means zero skills, silently: the model is told about
# none and nothing in the log says a skill went missing. The skills are therefore baked
# into the image at `$SKILLS_SEED_DIR` (see `Dockerfile`) and copied into the volume
# here, once.
#
# `seed_skills` is idempotent by design: it copies only when the mount has no content,
# and a mount that already has content — an operator's own skills, a skill they edited
# — is left exactly as it is. There is no reconciliation pass, so a careful operator is
# never overruled by an image upgrade.
set -e

# The seed baked into the image, and the mount the workspace sees. Both are overridable
# only so the seeding step can be run against temp directories; the compose files set
# neither.
SKILLS_SEED_DIR="${SKILLS_SEED_DIR:-/opt/agentdocumentor/skills}"
SKILLS_TARGET_DIR="${SKILLS_TARGET_DIR:-/data/workspace/.pi/skills}"

# Runs the seeding step and stops. Set by `test/entrypoint-skills-seed.test.ts` and by
# nothing else: the production path below continues into `su-exec` and `node`, and a test
# on a laptop must be able to execute this step without either.
SKILLS_SEED_ONLY="${SKILLS_SEED_ONLY:-}"

# Copies the image's copy into the mount when the mount has nothing in it, and prints one
# line either way so the state a container started in is observable.
seed_skills() {
  seed="$1"
  target="$2"

  # `-A` counts dotfiles too, and an absent directory counts as empty: the mount may not
  # exist yet on a volume that was wiped between boots.
  if [ -n "$(ls -A "$target" 2>/dev/null || true)" ]; then
    echo "skills-seed: $target already has content, left untouched"
    return 0
  fi

  mkdir -p "$target"
  # No fallback here on purpose. A missing seed is a broken image, and the boot must fail
  # loudly rather than come up healthy with zero skills — which is the state this whole
  # step exists to remove.
  cp -a "$seed"/. "$target"/
  # Only root can chown, and only root has anything to correct: the copy is root-owned,
  # while an unprivileged run already owns what it just wrote. Guarding on `id -u` is what
  # lets a developer or a test run this same code path.
  if [ "$(id -u)" = "0" ]; then
    chown -R node:node "$target"
  fi
  echo "skills-seed: $target was empty, seeded from $seed"
}

seed_skills "$SKILLS_SEED_DIR" "$SKILLS_TARGET_DIR"

if [ -n "$SKILLS_SEED_ONLY" ]; then
  exit 0
fi

if [ "$(id -u)" = "0" ]; then
  if [ -d /data ]; then
    chown -R node:node /data
  fi
  exec su-exec node "$@"
fi

exec "$@"
