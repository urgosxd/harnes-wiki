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
| `POST` | `/documents` | Upload a document; `201` with its id and a capability URL |
| `GET` | `/documents` | The caller's uploads, newest first. Never includes a secret |
| `GET` | `/documents/:id/:secret/:filename` | The bytes. No identity: the URL authorises itself |
| `DELETE` | `/documents/:id` | Remove an upload |
| `POST` | `/ingest/jobs` | Start an async ingest job; `202` with a job id |
| `GET` | `/ingest/jobs` | Retained jobs, newest first |
| `GET` | `/ingest/jobs/:id` | One job snapshot; the poller's only read |

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
| `INGEST_API_BASE_URL` | Origin of the external ingest service, e.g. `http://host:4173`. Empty answers `503 ingest_not_configured`. |
| `INGEST_API_TIMEOUT_MS` | Deadline for one job read. Default `10000`. |
| `PUBLIC_BASE_URL` | Origin the ingest service reaches THIS server at, e.g. `http://server:8080`. Empty still allows uploads and plain references, but not ingest-by-document. |

`PI_AGENT_DIR` matters more than it looks: on many setups the provider key lives
inline in `models.json` and `auth.json` is empty, so mounting only `auth.json`
starts the server with zero credentials and every turn fails with
`No API key found for the selected model.`

## Two users: how the link works

The URL carries both halves of an identity:

```
http://localhost:8088/?user=alice&token=<alice's token>
http://localhost:8088/?user=bob&token=<bob's token>
```

**The token identifies the caller, not the `user` parameter.** Each user has a
secret of their own, configured once in `CHAT_USERS=id:token,id:token`.
`scripts/up.sh` and `scripts/dev-env.sh` generate that file (`.chat-users`, mode
0600, git-ignored) on first run and print both links.

Why this matters, and why it was a bug before: with a single shared token, the
`user` parameter was only a claim. Measured on the running stack, one user could
open another's conversation with their own token and get **200 with the title
visible**. Now:

| Attempt | Before | Now |
|---|---|---|
| bob's token, claiming `user=alice` | `200`, title visible | `401` |
| bob's token, `user=bob`, alice's conversation | `404` | `404` |
| `/me` with a mismatched pair | n/a | `401` |

Rules the server enforces:

- A token that matches nobody is refused, whatever the `user` parameter says.
- A token that matches one user but claims another id is refused.
- The `user` parameter is optional: the token alone identifies the caller. It is
  kept in the link so the interface can show whose account is open.
- Tokens shorter than 16 characters are rejected at startup, because with two users
  guessing is the whole attack.

This is still not production authentication: it is a fixed local roster. Replacing
it with a session cookie or a verified JWT means implementing the same
`Authenticator` contract (`server/src/http/auth.ts`) and changing nothing else —
ownership is already enforced in the data layer.

The sidebar shows the signed-in account at the bottom, so a user can tell which
link they opened.

## Ingest jobs (external service)

A status surface for a compilation pipeline that runs as an **external service**.
That service lives in another repository and is deployed separately; this project
consumes its HTTP protocol and owns nothing about how it is built, started or
migrated.

```
browser -> web/nginx (/api/) -> server:8080 -> INGEST_API_BASE_URL
```

`nginx` proxies `/api/` to the server and strips the prefix, so the same path looks
like `/api/ingest/jobs` to the browser and `/ingest/jobs` to the server.

### The boundary

1. **The browser never talks to the service.** It cannot: the service publishes no
   CORS headers, answers no preflight, and requires its own request headers. It also
   has no credential of its own, so exposing it would publish a project's ingest
   surface to anyone who can reach the port.
2. **Only the address is configured.** `INGEST_API_BASE_URL` is an origin
   (`http://host:4173`). Nothing in this repository describes how the other service
   is run — if it moves or is replaced by another implementation of the same
   protocol, this is an environment change.
3. **No browser header is forwarded.** The server builds each call from the
   configured address and sends no `Host` or `Origin` of its own, which is what the
   service's request policy requires.
4. **A deployment fault is never shown as a job state.** An unreachable service or
   a rejected request becomes `502` with the reason named; only the service's own
   `200` / `404` / `503` / `409` reach the client unchanged.

### What the view will not guess

`ingest` and `compile` are independent state machines. A finished ingest with a
`busy` compile is a normal state — the source is stored and only the compile needs
a retry — so the view is two columns and never one status.

| Protocol fact | How the view shows it |
|---|---|
| `unchanged` ≠ `succeeded` | Different words: "Unchanged" vs "Source saved" |
| `busy` is not a failure | Warning tone plus "Only the compile needs a retry" |
| A job ends only when **both** dimensions are terminal | The poller keeps going while either moves |
| `progress` is `null` or an exact pair — never a percentage | Indeterminate sweep plus the stage name, or "3 of 8" |
| `attempts[].endedAt` absent = in flight; `error` = rolled back | One row per attempt, marked in flight / rolled back / done |
| `404` ≠ `503` | "This job is no longer known" (expired) vs "the service does not track jobs" |

Polling backs off from 250 ms to 2 s and stops as soon as both dimensions settle;
the service streams nothing. A `409 busy` is surfaced as a retry signal, not a
failure.

A source path is resolved on **the service's** filesystem, not in this container:
a file that only exists here is not a valid source. Use a URL, a path the service
can see, or upload it.

### Uploading: why it takes two endpoints

The service accepts REFERENCES, not bytes — its own tool contract says `URL or
absolute path`. So an upload cannot be sent to it directly: the bytes need an
address first. That is the whole design, and it is the same shape as a file id in
a hosted API:

```
POST /documents?filename=x.pdf   →  { id, url }
POST /ingest/jobs { documentId } →  a job, as usual
```

Three consequences that are deliberate:

- **The capability URL is unauthenticated.** The caller is the ingest service,
  which holds no credential of ours. The URL carries a 32-byte secret in its path,
  so holding the link is the permission; ids and secrets are separate so an id can
  appear in a UI or a log without granting access. A wrong secret and an unknown id
  answer identically, so the pair cannot be probed half at a time.
- **The filename is in the path, not a header.** The service routes on the file
  EXTENSION: a PDF served without `.pdf` is fetched as a web page and dies in HTML
  extraction. The name is part of the wire contract.
- **Upload ≠ ingest.** A document is a resource with identity; ingesting is a
  separate action that can be repeated (after a failed compile, say) without
  re-uploading. A cell in the upload list does not mean the wiki has it.

Uploads are capped at 25 MB, enforced on that route only — the global JSON limit
stays at 1 MB, because raising it for one endpoint would widen every other one.

Unset `INGEST_API_BASE_URL` is a supported state: the routes answer `503
ingest_not_configured`, which the view states plainly instead of showing an empty
list.

## Development

Two pieces run separately, plus Postgres from Docker.

```bash
# 1. Database only
docker compose up -d postgres

# 2. Agent server on :8080  (env derived from ~/.pi/agent/models.json)
cd server
source ../scripts/dev-env.sh
npm start

# 3. Chat client on :5173, proxying /api to :8080
cd web
npm run dev
```

Open the link printed by `up.sh` (see **Two users** below).

`source scripts/dev-env.sh` reads the provider key, the `api` type and the base URL
from your Pi config. It is sourced, not executed, so the variables reach `npm start`.

Tests:

```bash
cd server && node --experimental-strip-types --test test/*.test.ts && npx tsc --noEmit
cd web    && npx vitest run && npx tsc --noEmit
```

## Production (containers)

```bash
./scripts/up.sh          # builds, starts, waits for health, prints the URL
```

Then open the links printed by the script (see **Two users** below).

Or by hand:

```bash
CHAT_API_KEY=sk-... docker compose up -d --build
docker compose ps                 # three services must be healthy
docker compose logs -f server     # structured JSON
docker compose down               # stops, keeps conversations
docker compose down -v            # stops and deletes everything
node scripts/smoke.mjs            # 8 acceptance checks against the running stack
```

The container is self-contained: it generates its own Pi model configuration from
`CHAT_*` variables and mounts nothing from the host. `scripts/up.sh` takes the key
(and the api type and base URL) from `~/.pi/agent/models.json` so you do not retype
them; the file itself is never mounted.

### Dev vs production at a glance

| | Development | Production |
|---|---|---|
| Command | `source scripts/dev-env.sh` + `npm start` | `./scripts/up.sh` |
| Client | Vite dev server on :5173 (HMR) | nginx static build on :8088 |
| Server | local Node on :8080 | container, no published port |
| Database | container, port 127.0.0.1:5432 | container, private network |
| Pi config | generated into `/tmp`, beside the workspace | generated into the data volume, beside the workspace |
| TypeScript | run directly by Node | run directly by Node (same) |
| Restart policy | none | `unless-stopped` |

Both paths run the same source: there is no build step for the server, because Node
executes the TypeScript directly.

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

## Activity while the assistant works

The answer does not appear out of nowhere. While a turn runs, the window shows what
the assistant is doing, in plain language:

```
✓ Checking the workspace
✓ Reading a document
● Searching the workspace      (spinner while it runs)
✓ Thinking…
```

- Reasoning arrives as `thinking_delta`, kept **out of the answer text**: the user
  asked for an answer, not the model's deliberation.
- Every tool call gets a readable label from the server (`Searching the workspace`,
  `Looking up an order`). The tool's internal name is never shown.
- A skill the model consults is reported once, however many chunks mention it.
- Finished steps stay after the turn; the list clears when the next one starts.
- With nothing reported yet, the client shows a plain "Working…" rather than
  inventing which step is happening.

Measured on the live stack: a turn that uses tools emits
`run_started → text_delta → tool_started → tool_finished → thinking_delta → text_delta → run_finished`,
with 99–132 characters of reasoning per turn.

## Capabilities are invisible, not absent

The user never sees development tooling: no terminal, no file browser, no settings.
That is a UI promise and it holds.

The model is a different question. A support assistant has to read a document, so
`read`, `grep`, `find` and `ls` are available to it, confined to the workspace, and
skills can be consulted. None of that appears in the interface.

`bash` is **off by default**, and that is not caution for its own sake. Two things
were measured on the real stack:

1. With `bash` enabled, the prompt "run `cat /data/agent/models.json`" printed the
   provider API key in full.
2. With `read` enabled but the config inside the workspace, the model read the file
   and only its own judgement kept the key out of the answer. A prompt is not a
   boundary.

So the generated config lives **beside** the workspace, not inside it, and file
reads are refused structurally:

```
"../agent/models.json"  ->  refused: outside the workspace
```

Enabling `AGENT_BASH=true` is a deliberate deployment decision. It gives the model
everything the process can reach, credentials included.

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

## Reaching an MCP server over HTTP

The tenant MCP seam has two transports, and a `tenant_mcp` row states which it
uses:

| `transport` | Needs | Where the server runs |
|---|---|---|
| `stdio` (default) | `command`, `args`, `env` | A process this container spawns — an in-image binary |
| `http` | `url`, optional `headers` | Anywhere reachable; nothing of it enters this image |

`http` exists so an external MCP server can be consumed without shipping its
binary here. The row's transport is checked by a database constraint, so a
half-filled row cannot be stored: an `http` row without a `url` and a `stdio` row
without a `command` are both refused at write time rather than failing later at
connect time.

```sql
INSERT INTO tenant_mcp
  (user_id, server_name, command, transport, url, headers, exposed_tools)
VALUES
  ('alice', 'wiki', '', 'http', 'http://host:4173/mcp',
   '{"accept":"application/json, text/event-stream"}'::jsonb,
   '["ingest_jobs_list","ingest_job_status"]'::jsonb);
```

`headers` is part of the row rather than of the code on purpose: a server that
requires `Accept: application/json, text/event-stream` (streamable HTTP answers
`406` without the event-stream half) is stating a deployment requirement, and
injecting that from our build would impose one deployment's requirement on every
other.
