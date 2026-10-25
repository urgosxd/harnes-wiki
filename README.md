# AgentDocumentor

A web chat product built on the [Pi coding agent SDK](https://pi.dev). Users get
their own independent, saved, resumable conversations. No development tooling is
exposed: no terminal, no file browser, no worktrees, no agent configuration.

## Layout

```
server/         Agent server: Pi SDK sessions, SSE, Postgres (Node 22 + TypeScript)
web/            Chat client (React)
odd/tasks/      Feature plan and evidence for the current work
```

## Requirements

- Node >= 22.19.0
- Docker with Compose (Postgres, and the full stack)
- A Pi agent directory holding provider credentials (`models.json`, and `auth.json`
  for OAuth providers)

## API

Every request needs an identity. Until real authentication is wired, the server
refuses everything unless `DEV_AUTH_TOKEN` is set, and then accepts
`x-dev-token: <token>` plus `x-user-id: <user>`. The user id is read from the
request headers only, never from a body or query parameter.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness |
| `GET` | `/conversations` | The caller's conversations, newest first |
| `POST` | `/conversations` | Create one |
| `GET` | `/conversations/:id` | Conversation plus projected messages |
| `PATCH` | `/conversations/:id` | Rename |
| `DELETE` | `/conversations/:id` | Archive |
| `POST` | `/conversations/:id/turns` | Run a turn, streaming SSE |

`POST /conversations/:id/turns` **requires** an `Idempotency-Key` header. Responses:

- `200` + `text/event-stream` when the turn starts. Frames: `run_started`,
  `text_delta`, `tool_started`, `tool_finished`, then `run_finished` or
  `run_failed`. The run id is in the `x-run-id` header.
- `409 turn_in_progress` when another turn holds the conversation.
- `200 duplicate_turn` when the key was already used; it returns the original run id
  instead of running again.
- `404` for a conversation that does not exist **or belongs to someone else**.
  Never `403`: a distinguishable answer would confirm someone else's conversation
  exists.

## Configuration

The server reads only these variables. There is deliberately no `.env` file in this
repository: export them from your shell or set them in `docker-compose.yml`.
Never commit provider credentials.

| Variable | Purpose |
|---|---|
| `PI_AGENT_DIR` | Pi agent directory holding `models.json` and, when needed, `auth.json`. Mounted read-only in containers. |
| `PI_WORKSPACE_DIR` | Neutral workspace handed to the session as `cwd`. Never a real project path. |
| `CHAT_PROVIDER` | Provider id for the chat model, e.g. `synthetic`. |
| `CHAT_MODEL` | Model id inside that provider. |
| `CHAT_THINKING_LEVEL` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `DATABASE_URL` | Postgres connection string. |

`PI_AGENT_DIR` matters more than it looks: on many setups the provider key lives
inline in `models.json` and `auth.json` is empty, so mounting only `auth.json`
starts the server with zero credentials and every turn fails with
`No API key found for the selected model.`

## Development

```bash
docker compose up -d postgres      # Postgres on 127.0.0.1:5432

# agent server (port 8080)
cd server
PI_AGENT_DIR=~/.pi/agent PI_WORKSPACE_DIR=/tmp/agentdoc-ws \
CHAT_PROVIDER=synthetic CHAT_MODEL=syn:large:text \
DATABASE_URL=postgres://agentdocumentor:agentdocumentor@127.0.0.1:5432/agentdocumentor \
DEV_AUTH_TOKEN=dev PORT=8080 npm start

# chat client (port 5173, proxies /api to 8080)
cd web && npm run dev
# open http://localhost:5173/?token=dev&user=alice
```

Tests:

```bash
cd server && node --experimental-strip-types --test test/*.test.ts && npx tsc --noEmit
cd web    && npx vitest run && npx tsc --noEmit
```

TypeScript runs directly through node's **strip-only** type support, so there is no
build step. Strip-only means syntax that emits JavaScript is rejected: no
`constructor(private x: T)` parameter properties, no `enum`, no `namespace`, no
decorators. Use a field and an explicit assignment instead. `tsc` still typechecks.

Tests that need Postgres or provider credentials skip (and are reported as
skipped) when those are unavailable; they never pass silently.

## Client

React 19 + Vite. `?token=` and `?user=` in the URL are a development convenience
for switching identity, not an authentication scheme.

Text is rendered as text, never as HTML: model output is untrusted input.
The SSE parser is hand-written because a chunk boundary can fall inside a frame,
inside a JSON string, or between the two newlines that end a record; assuming one
chunk equals one frame works in development and corrupts long replies.

Vite is pinned to 7.x because `@vitejs/plugin-react` does not support Vite 8 yet.
Installing Vite 8 fails on a peer conflict; do not paper over it with
`--legacy-peer-deps`.

## Acceptance: isolation and concurrency

`server/test/isolation.test.ts` is the MVP's definition of done. It defaults to 2
users (`ISOLATION_USERS=5` for the full run) and nothing in it is specific to that
number:

```bash
cd server && node --experimental-strip-types --test test/isolation.test.ts
ISOLATION_USERS=5 node --experimental-strip-types --test test/isolation.test.ts
```

It asserts, for real users over HTTP: concurrent turns keep separate histories
(each recalls its own secret and never another's), a foreign conversation is 404
for read/write/rename/delete, sidebars never show another user's rows, two
simultaneous turns on one conversation yield exactly one 200 and one 409, MCP
connections are per tenant and do not grow with turns, each tenant's MCP tool runs
against its own connection, and a business tool enforces only its tenant's scope.

Both properties were mutation-checked: removing the ownership predicate makes all
seven tests fail, and rebuilding the tenant runtime per turn fails the process
count with "6 MCP process(es) were spawned for turns". A passing run therefore
means something.

## Trying it out (MVP)

The fastest path, which is what this build is for:

```bash
docker compose up -d --build      # no environment variables needed
```

The container is self-contained: it generates its own Pi model configuration from
environment variables, and **no host directory is mounted**. `CHAT_API_KEY` is the
only value it needs, and `scripts/up.sh` reads it from your existing
`~/.pi/agent/models.json` so you do not have to retype it.

Then open **<http://localhost:8088/?token=dev&user=alice>** and start chatting.
Change `user=` to get a separate account: that parameter IS the whole identity
model right now.

| Situation | What happens |
|---|---|
| Open `http://localhost:8088/` with no parameters | A sign-in screen asks for a name and token. It does not leave you with an empty chat and a 401 in the console. |
| Wrong token | The sign-in screen returns and says the token was rejected. |
| `?token=dev&user=alice` | Straight into that user's conversations. |
| `?token=dev&user=bob` | A different, empty list. Conversation histories never mix. |

The token is whatever `DEV_AUTH_TOKEN` was set to (default `dev`). Anyone who has
it can claim any name, so treat this as a local development mode.

### How authentication would work for real

The current scheme is a deliberate seam, not a design:

- The server refuses every request without a resolvable identity. There is no
  anonymous fallback, because an anonymous fallback is how one user ends up
  reading another's conversation.
- The user id comes **only** from the request headers, never from a body field or
  query parameter that a client could set to someone else's id.
- Conversation lookups fold `user_id` into the SQL predicate, so a foreign
  conversation is indistinguishable from a missing one (404, never 403).

Replacing the seam means implementing `createAuthenticator` in
`server/src/http/auth.ts` to return a user id from a real credential: a signed
session cookie, or a JWT verified against an identity provider. Nothing else in
the system changes, because ownership is already enforced at the data layer rather
than in the UI. The remaining production gaps are listed at the end of
`odd/tasks/pi-chat-mvp.md`.

## Running the full stack

```bash
docker compose up -d --build
open http://localhost:8088/?token=dev&user=alice
node scripts/smoke.mjs                    # 7 acceptance checks
```

Every variable has a working default; the two below are only needed to override it.

| Variable | Default | Meaning |
|---|---|---|
| `CHAT_API_KEY` | **required** | Provider key. `scripts/up.sh` fills it from `~/.pi/agent/models.json`. The server validates it at startup, not Compose: a `:?` in the compose file would break `down`, `ps` and `logs` too. |
| `CHAT_PROVIDER` | `synthetic` | Provider id written into the generated config. |
| `CHAT_MODEL` | `syn:large:text` | Model id. |
| `CHAT_BASE_URL` | `https://api.synthetic.new/openai/v1` | Provider endpoint. |
| `CHAT_API` | `openai-completions` | One of `openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`. |
| `CHAT_CONTEXT_WINDOW` / `CHAT_MAX_TOKENS` / `CHAT_REASONING` | `524288` / `65536` / `true` | Model capabilities. |
| `DEV_AUTH_TOKEN` | `dev` | Token the app asks for. |
| `POSTGRES_PASSWORD` | `agentdocumentor` | Local only. |

### Self-contained container

The service writes `/data/workspace/agent/models.json` (mode 0600) at boot from the
`CHAT_*` variables, then uses it as its Pi agent directory. The SDK ships no
built-in model catalog - measured: zero models with empty configuration - so this
generated file is what makes the container work without any host state.

`PI_AGENT_CONFIG_MODE=mounted` remains available for a team secret: it takes an
agent directory read-only and copies `models.json` and `auth.json` into the data
volume, because Pi's credential store needs a writable location for its lock.


Services: `postgres` (loopback only), `server` (no published port), `web` (nginx on
127.0.0.1:8088). The API is reachable only from the web container, through the
private network.

```bash
docker compose ps                         # health of all three
docker compose logs -f server             # structured JSON logs
docker compose down                       # keeps the data volume
docker compose down -v                    # destroys conversations
```

Logs are one JSON object per line and redact secrets by key name. Set `LOG_LEVEL`
to `debug`, `info`, `warn` or `error`.

### Two deployment traps this stack solves

**Credentials must live somewhere writable.** Pi's credential store takes a lock
beside `auth.json` and recreates the file when missing, so pointing it at a
read-only mount fails with `EROFS: read-only file system, mkdir
'<agentDir>/auth.json.lock'`. The server copies `models.json` and `auth.json` into
the data volume at boot, with mode 0600, and never copies `AGENTS.md`, skills or
extensions.

**The credential lookup does not follow the agent dir you pass it.**
`ModelRuntime.create()` without explicit paths resolves through `HOME` and
`PI_CODING_AGENT_DIR`. That matches `~/.pi/agent` on a developer machine, so the
bug is invisible until deployment, where it resolved to 0 models and every start
died with "model is not available". The runtime now passes `authPath`,
`modelsPath` and `modelsStorePath` explicitly, and
`test/agent-dir-portability.test.ts` runs it with a clean `HOME` to keep it that way.

## Design constraints that are not negotiable

These were established by running the SDK, not by reading its docs. Changing any of
them reintroduces a bug that was already observed.

1. **Every `@earendil-works/*` package is pinned to `1.4.0`, exactly.** Pi's packages
   depend on each other with `^` ranges; if they resolve out of step, the integration
   breaks. `server/test/pins.test.ts` fails the build when a range floats.
2. **Postgres is the single source of truth for the transcript.** The SDK keeps
   `SessionManager.getEntries()` flat during a turn and creates the session file only
   after the first assistant message, so a crash mid-turn loses the turn entirely.
   Sessions are rebuilt per turn with `SessionManager.inMemory(cwd, {id}, entries)`.
3. **MCP is one long-lived client per tenant, proxied as custom tools.** The built-in
   MCP extension spawns one child process per session and does not reap it on
   dispose.
4. **`prompt()` resolving does not mean the turn succeeded.** Read `stopReason` from
   the persisted assistant message.
5. **`agent_settled` ends a run.** `agent_end` does not: retries and queued work can
   follow it.
6. **The transcript is append-only at the database level.** A trigger refuses
   `UPDATE` and direct `DELETE` on `session_entries`. The cascade from deleting a
   conversation is allowed, because refusing it would make user deletion
   impossible; the two are told apart by whether the parent row still exists.

## Status

Implementation in progress. See `odd/tasks/pi-chat-mvp.md` for the task list, the
acceptance checklist, and the evidence log.
