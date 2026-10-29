#!/usr/bin/env bash
#
# Build both services for linux/amd64 and linux/arm64 as one multi-arch tag each.
#
#   ./scripts/build.sh 0.1.0                  # local only: tags in this machine
#   PUSH=1 REGISTRY=ghcr.io/me ./scripts/build.sh 0.1.0
#
# ## Why buildx and not `docker build`
#
# The classic builder cannot produce a manifest list. `--load` even refuses to load
# one unless the daemon uses containerd's image store. So the build goes through a
# `docker-container` builder, which handles both platforms regardless of what the
# local daemon can run, and `--push` publishes the manifest list where a registry
# can serve it.
#
# ## Why nothing here is guessed
#
# A default REGISTRY would publish images into somebody else's namespace, and a
# default version would make a deployment impossible to pin. Both are required, and
# a missing one is named rather than filled in.
#
# ## What a consumer gets
#
#   docker compose -f docker-compose.prod.yml up -d
#
# Docker resolves linux/amd64 or linux/arm64 from the tag by itself. Nothing in the
# consuming host has to know which architecture it is.
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  cat >&2 <<'MESSAGE'
usage: ./scripts/build.sh <version>

  ./scripts/build.sh 0.1.0
  PUSH=1 REGISTRY=ghcr.io/your-user ./scripts/build.sh 0.1.0

The version is required on purpose: a deployment has to be able to name exactly
which build it is running, and a script that invents one cannot promise that.
MESSAGE
  exit 1
fi

# Refuse a version that would silently become a path or a shell word.
if ! printf '%s' "$VERSION" | grep -Eq '^[A-Za-z0-9._-]+$'; then
  echo "version must match [A-Za-z0-9._-], got \"$VERSION\"" >&2
  exit 1
fi

PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILDER="${BUILDER:-multibuilder}"
PUSH="${PUSH:-0}"
# Empty REGISTRY means "local images only". Set it to push.
REGISTRY="${REGISTRY:-}"
REGISTRY="${REGISTRY%/}"

image_name() {
  local service="$1"
  if [ -n "$REGISTRY" ]; then
    printf '%s/agentdocumentor-%s' "$REGISTRY" "$service"
  else
    printf 'agentdocumentor-%s' "$service"
  fi
}

# The builder has to exist and be of a driver that can build multi-arch. Creating it
# on a machine that already has one would fail, so it is only created when missing.
if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  echo "creating buildx builder \"$BUILDER\""
  docker buildx create --name "$BUILDER" --driver docker-container >/dev/null
fi
docker buildx inspect "$BUILDER" --bootstrap >/dev/null

OUTPUT="--load"
if [ "$PUSH" = "1" ]; then
  if [ -z "$REGISTRY" ]; then
    echo "PUSH=1 needs REGISTRY, e.g. REGISTRY=ghcr.io/your-user" >&2
    exit 1
  fi
  OUTPUT="--push"
else
  if [ -n "$REGISTRY" ]; then
    echo "note: REGISTRY is set but PUSH is not, so images stay local and are tagged with the registry prefix"
  fi
  # `--load` of a manifest list needs containerd's image store. Say so up front
  # instead of failing halfway through the second service.
  if ! docker info 2>/dev/null | grep -qi "containerd"; then
    cat >&2 <<'MESSAGE'
This Docker daemon cannot load a multi-arch image locally.

Two ways forward:
  1. Publish instead:   PUSH=1 REGISTRY=<registry>/<namespace> ./scripts/build.sh <version>
  2. Build one platform at a time and load that:
     PLATFORMS=linux/arm64 ./scripts/build.sh <version>

Loading a manifest list into the local image store requires containerd storage,
which this daemon does not report.
MESSAGE
    exit 1
  fi
fi

echo "version:   $VERSION"
echo "platforms: $PLATFORMS"
echo "builder:   $BUILDER"
echo "registry:  ${REGISTRY:-<local only>}"
echo "output:    ${OUTPUT#--}"
echo

for service in server web; do
  name="$(image_name "$service")"
  docker buildx build \
    --builder "$BUILDER" \
    --platform "$PLATFORMS" \
    --file "$service/Dockerfile" \
    --tag "$name:$VERSION" \
    --tag "$name:latest" \
    $OUTPUT \
    "$service"
  echo "  -> $name:$VERSION"
done

echo
if [ "$PUSH" = "1" ]; then
  echo "published. On the target host:"
  echo
  echo "  REGISTRY=$REGISTRY VERSION=$VERSION \\"
  echo "    docker compose -f docker-compose.prod.yml pull"
  echo "  REGISTRY=$REGISTRY VERSION=$VERSION \\"
  echo "    docker compose -f docker-compose.prod.yml up -d"
else
  echo "built locally. Verify the manifest lists:"
  echo
  for service in server web; do
    echo "  docker buildx imagetools inspect $(image_name "$service"):$VERSION"
  done
fi
