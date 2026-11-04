# Node runs TypeScript natively (type stripping), so there is no build step and no
# transpiled output to keep in sync with the source. The trade-off is a hard
# constraint: type stripping rejects syntax that emits JavaScript (parameter
# properties, enum, namespace, decorators). Pinning the Node image exactly is what
# keeps that guarantee stable across rebuilds.
# ---- test ----
#
# The runtime image below installs with `--omit=dev` on purpose, so it cannot run the
# suite. This stage carries the test toolchain instead of a workflow installing it ad
# hoc: CI and a laptop then build the same image from the same lockfile, and the
# Dockerfile itself is part of what the gate proves.
#
# It is FIRST so the runtime stage stays the last (and therefore default) target:
# `docker compose build` keeps producing the production image, and
# `docker build --target test` produces this one.
FROM node:22.23.2-alpine AS test

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force

COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json ./

# The suite is NOT copied in: `.dockerignore` keeps `test/` out of every image on
# purpose — it is the one place a real credential could be baked in by accident — and
# that reasoning outranks the convenience of a self-contained test image.
# `scripts/ci.sh` mounts the checked-out `test/` read-only at run time instead, which
# also means the tests that run are always the ones in the working tree.
#
# The database is supplied the same way: `scripts/ci.sh` starts one, points DATABASE_URL
# at it, and CI_REQUIRE_DATABASE makes a missing one a failure rather than a skip.
CMD ["npm", "test"]

# ---- runtime (default target) ----
FROM node:22.23.2-alpine

WORKDIR /app

# Dependencies first, so a source change does not reinstall them.
COPY package.json package-lock.json ./
# --omit=dev keeps the test toolchain out of the runtime image.
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
# Operator scripts ship WITH the image, because they are the only supported way to
# grant a user the external MCP tools and there is no source tree in production.
# Measured consequence of leaving them out: `provision-mcp.mjs` could not be run in
# a deployed stack at all — verified with `ls /app/scripts` on the published image,
# which returned nothing.
COPY scripts ./scripts
COPY tsconfig.json ./
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

# su-exec lets the entrypoint drop from root to `node` after taking ownership of
# the data volume. Without it the process would have to run as root.
RUN apk add --no-cache su-exec && chmod +x /usr/local/bin/entrypoint.sh

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# Runs as `node` in practice: the entrypoint chowns /data and drops privileges.
# The server refuses to start without configuration rather than guessing, so a
# missing PI_AGENT_DIR or DATABASE_URL fails loudly here instead of at first turn.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "src/main.ts"]
