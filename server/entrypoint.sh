#!/bin/sh
# A named volume is created owned by root, but the server runs as `node`. Rather
# than requiring the host to chown a Docker-internal path (or running the server as
# root), take ownership of the writable volume here and drop privileges.
#
# Only the writable volumes are touched: the data volume (owned by `node` below), the
# skills volume and the agents volume (both seeded below). The agent directory stays a
# read-only mount.
#
# ## Seeding the content volumes
#
# Production mounts NAMED volumes over `<workspace>/.pi/skills` and over the agents
# directory (`$HOME/.agents/agents`), so on a first boot both directories are EMPTY. An
# empty skills directory silently means zero skills; an empty agents directory means zero
# definitions, and then `AGENT_DEFINITION=<name>` fails the boot with "not found" on a
# deployment whose image carries the file — the failure shows up in someone's face at the
# worst moment. Both copies are therefore baked into the image (see `Dockerfile`) and
# copied into their volume here, once.
#
# The seeds sit at `/opt/agentdocumentor/skills` and `/opt/agentdocumentor/agents`, which
# are at NEITHER discovery scope, so there is one copy of each document rather than two.
#
# `seed_volume` is idempotent by design: it copies only when the mount has no content, and
# a mount that already has content — an operator's own skills, a role they corrected —
# is left exactly as it is. There is no reconciliation pass, so a careful operator is
# never overruled by an image upgrade. That is also what makes a corrected role a `cp`
# instead of a release.
set -e

# The seeds baked into the image, and the mounts the container sees. All four are
# overridable only so the seeding steps can be run against temp directories; the compose
# files set none of them.
SKILLS_SEED_DIR="${SKILLS_SEED_DIR:-/opt/agentdocumentor/skills}"
SKILLS_TARGET_DIR="${SKILLS_TARGET_DIR:-/data/workspace/.pi/skills}"
AGENTS_SEED_DIR="${AGENTS_SEED_DIR:-/opt/agentdocumentor/agents}"
AGENTS_TARGET_DIR="${AGENTS_TARGET_DIR:-/home/node/.agents/agents}"

# Runs one seeding step and stops. Set by `test/entrypoint-skills-seed.test.ts` and
# `test/agents-volume-seed.test.ts` and by nothing else: the production path below
# continues into `su-exec` and `node`, and a test on a laptop must be able to execute a
# seeding step without either.
SKILLS_SEED_ONLY="${SKILLS_SEED_ONLY:-}"
AGENTS_SEED_ONLY="${AGENTS_SEED_ONLY:-}"

# Copies the image's copy into the mount when the mount has nothing in it, and prints one
# line either way so the state a container started in is observable.
seed_volume() {
  label="$1"
  seed="$2"
  target="$3"

  # `-A` counts dotfiles too, and an absent directory counts as empty: the mount may not
  # exist yet on a volume that was wiped between boots.
  if [ -n "$(ls -A "$target" 2>/dev/null || true)" ]; then
    echo "$label-seed: $target already has content, left untouched"
    return 0
  fi

  # No fallback here on purpose. A missing seed is a broken image, and the boot must fail
  # loudly rather than come up healthy with zero skills or zero definitions — which is the
  # state this whole step exists to remove. The failure is worded here instead of left to
  # `cp`, because `cp` reports `cannot stat` against a target `mkdir -p` has just created,
  # which reads like a permissions accident in the volume: name what is missing, and what
  # the operator can do about it, then stop non-zero exactly as before. It is checked
  # BEFORE the `mkdir`, so a boot that cannot fill the volume does not leave an empty
  # directory behind to confuse the next diagnosis.
  if [ ! -d "$seed" ]; then
    echo "$label-seed: $target is empty and this image carries no seed at $seed" >&2
    echo "$label-seed: nothing was copied and the boot is stopping here rather than starting without $label; rebuild the image from the deployment's checkout (its $label are baked in at $seed), or mount a directory that already has content" >&2
    exit 1
  fi
  mkdir -p "$target"
  cp -a "$seed"/. "$target"/
  # Only root can chown, and only root has anything to correct: the copy is root-owned,
  # while an unprivileged run already owns what it just wrote. Guarding on `id -u` is what
  # lets a developer or a test run this same code path.
  if [ "$(id -u)" = "0" ]; then
    chown -R node:node "$target"
  fi
  echo "$label-seed: $target was empty, seeded from $seed"
}

seed_skills() {
  seed_volume skills "$1" "$2"
}

seed_agents() {
  seed_volume agents "$1" "$2"
}

seed_skills "$SKILLS_SEED_DIR" "$SKILLS_TARGET_DIR"

if [ -n "$SKILLS_SEED_ONLY" ]; then
  exit 0
fi

seed_agents "$AGENTS_SEED_DIR" "$AGENTS_TARGET_DIR"

if [ -n "$AGENTS_SEED_ONLY" ]; then
  exit 0
fi

if [ "$(id -u)" = "0" ]; then
  if [ -d /data ]; then
    chown -R node:node /data
  fi
  exec su-exec node "$@"
fi

exec "$@"
