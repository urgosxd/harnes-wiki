# Node runs TypeScript natively (type stripping), so there is no build step and no
# transpiled output to keep in sync with the source. The trade-off is a hard
# constraint: type stripping rejects syntax that emits JavaScript (parameter
# properties, enum, namespace, decorators). Pinning the Node image exactly is what
# keeps that guarantee stable across rebuilds.
FROM node:22.23.2-alpine

WORKDIR /app

# Dependencies first, so a source change does not reinstall them.
COPY package.json package-lock.json ./
# --omit=dev keeps the test toolchain out of the runtime image.
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
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
