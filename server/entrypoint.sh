#!/bin/sh
# A named volume is created owned by root, but the server runs as `node`. Rather
# than requiring the host to chown a Docker-internal path (or running the server as
# root), take ownership of the writable volume here and drop privileges.
#
# Only the data volume is touched. The agent directory stays a read-only mount.
set -e

if [ "$(id -u)" = "0" ]; then
  if [ -d /data ]; then
    chown -R node:node /data
  fi
  exec su-exec node "$@"
fi

exec "$@"
