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

Every request must name a caller, and the caller is a signed-in account: sign in with
`POST /login`, keep the `sid` cookie it sets, and send it with every later request. A
request without a valid session is `401`. See **Sign in: a user and a password** below for
the whole model, and for the legacy `AUTH_MODE`s that still identify a caller from
headers.

```bash
curl -c cookies.txt -X POST http://127.0.0.1:8088/api/login \
  -H 'content-type: application/json' \
  -d '{"user":"alice","password":"<from DEFAULT_USERS, or from the first boot log>"}'
# 200 {"user":{"id":"alice","displayName":"alice"}}

curl -b cookies.txt http://127.0.0.1:8088/api/me   # 200 {"id":"alice","displayName":"alice"}
```

The legacy modes (`open`, `shared-token`, `roster`) still identify a caller from the
`x-user-id` and `x-dev-token` headers, and exist for the test suites and for an API
deployment that deliberately has no accounts. The web client does not support them.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness. The one route that needs no session |
| `POST` | `/login` | Sign in with `{user,password}`; `200` plus the `sid` cookie |
| `POST` | `/logout` | Sign out; `204`, and the cookie is cleared |
| `GET` | `/me` | `{id,displayName}` of the session's account |
| `POST` | `/users` | Create an account from `{user,password,displayName?}`; `201` |
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
| `GET` | `/stacks` | The Stack ids the service lists, so a client can offer a choice. Read-only |

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
| `AUTH_MODE` | `password` (the default), or the legacy `open`, `shared-token` and `roster`. Chooses how a caller is identified; see **Sign in: a user and a password**. |
| `DEFAULT_USERS` | `id:password,id:password` for the two accounts a fresh database gets (`alice`, `bob`). Unset means their passwords are generated at the first boot and printed once in the server log. |
| `CHAT_USERS` | **Legacy, roster mode only**: `id:token,id:token`, read only when `AUTH_MODE=roster`, never by the password path. Normally **not set at all**: both compose files mount `.chat-users` read-only and the entrypoint exports this from it. |
| `CHAT_API_KEY` | Provider key. The container generates its own `models.json` from it and never carries it in the image. |
| `POSTGRES_PASSWORD` | Database password. Applied on the volume's first `initdb` only; see the note below. |
| `PI_WORKSPACE_DIR` | Neutral workspace handed to the session as `cwd`. Never a real project path. |
| `PI_AGENTS_DIR` | Directory holding agent definitions (`*.md`). Defaults to `$HOME/.agents/agents`; a missing directory is allowed. The selected definition's FILE is re-read on every turn. |
| `AGENT_DEFINITION` | Name of the agent definition to apply, e.g. `documentor` or `wiki-agentic-search`. Empty (the default) uses the plain system prompt. The SELECTION is read once at startup, so changing it needs a restart; the selected file's TEXT is re-read on every turn, so editing it does not. |
| `CHAT_PROVIDER` | Provider id for the chat model, e.g. `synthetic`. |
| `CHAT_MODEL` | Model id inside that provider. |
| `CHAT_THINKING_LEVEL` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `DATABASE_URL` | Postgres connection string. |
| `INGEST_API_BASE_URL` | Origin of the external ingest service, e.g. `http://host:4173`. Empty answers `503 ingest_not_configured`. |
| `INGEST_API_TIMEOUT_MS` | Deadline for one job read. Default `10000`. |
| `MCP_REQUEST_TIMEOUT_MS` | Deadline for one MCP tool request, e.g. `query_wiki`. Default `120000` (120 s); the MCP client library's own default is 30 s, which timed out on a large Stack. A value that is not a positive number FAILS the boot rather than falling back. |
| `PUBLIC_BASE_URL` | Origin the ingest service reaches THIS server at, e.g. `http://server:8080`. Empty still allows uploads and plain references, but not ingest-by-document. |

`PI_AGENT_DIR` matters more than it looks: on many setups the provider key lives
inline in `models.json` and `auth.json` is empty, so mounting only `auth.json`
starts the server with zero credentials and every turn fails with
`No API key found for the selected model.`

### Agent definitions

An agent definition is a role for the agent: a `name`, a `description` and a body of
text. `server/agents/documentor.md` is the example this repository ships.

**The file's text is read once per TURN, not once per process.** `AGENT_DEFINITION`
selects which definition to apply and is still a startup fact — change it and you restart —
but the selected file is re-read from disk on every turn and lands in that turn's leading
system prompt. So correcting a role is an edit, not a release: the next message uses the
new text, with no restart, no rebuild and no new tag. A `role_notice` sentence in the
turn's own output says so when the text on disk cannot be used or names tools this
deployment does not have (see **Correcting a role** below).

#### The operating model: one role, edited in place

Read this before inferring a hot-swap from the mechanism. There is ONE role per
deployment:

- `AGENT_DEFINITION=<name>` is set at deployment and stays. It selects which definition
  is applied, and changing it needs a restart. With one role, you should never need to.
- What changes at runtime is the CONTENT of that role's file: correct its text, save it
  into the volume, and the next message uses it — no restart, no rebuild, no new tag.
- Nothing switches roles at runtime. There is no `.active` marker, no stored selection, no
  fallback from one definition to another. The server reads the one file the selection
  names, once per turn, and applies it.

#### Which definition is applied (the identity rule)

The applied definition is the one whose frontmatter **declares** the selected name:

```yaml
---
name: wiki-agentic-search     # THIS is the identity AGENT_DEFINITION matches
description: Agentic search over the wiki
---
```

The FILE NAME is not part of the identity. A file called `role-v2.md` that declares
`name: wiki-agentic-search` is what `AGENT_DEFINITION=wiki-agentic-search` applies; a file
called `wiki-agentic-search.md` that declares `name: something-else` is not. The reason is
the loader's own contract: it keys a directory by what each file declares, so an uploaded
role can be named anything and the identity stays one frontmatter line — which also means
a rename is never a silent change of what is applied.

A violation is never silent:

| Where | What happens |
|---|---|
| at boot | `AGENT_DEFINITION` naming a declaration no file carries fails the start, with the names the directory does declare. |
| at turn time | a file whose `name:` no longer matches the selection is REFUSED: the turn runs with the last valid text, the log warns naming both names, and the turn shows a notice saying the file declares a name this deployment did not select. |
| two files declaring the same name | the load fails naming both paths: which one wins must not be a filesystem accident. |

Editing only the BODY — the normal correction path — cannot disturb the selection: the
frontmatter is untouched, so the identity the selection matches does not move.

Where the directory comes from differs by stack, exactly as it does for skills:

| | Development | Production |
|---|---|---|
| Source | bind mount of `./server/agents`, read-only | named volume `agentdoc-agents`, seeded from the image |
| Host path read | `server/agents` | **none** |
| A correction | edit the file in the repo | `docker cp`/`cp` into the volume, or edit it from a container |

**Development** bind-mounts `./server/agents` read-only to `/home/node/.agents/agents`, so
an edit to a `.md` is what the next turn sees.

**Production** mounts the named volume `agentdoc-agents` at that path. The image carries a
seed at `/opt/agentdocumentor/agents` — at neither discovery scope on purpose, so there is
one copy of each definition — and `server/entrypoint.sh` copies it into the volume on a
first boot, when the mount is missing or empty. It prints one line either way:

```text
agents-seed: /home/node/.agents/agents was empty, seeded from /opt/agentdocumentor/agents
agents-seed: /home/node/.agents/agents already has content, left untouched
```

**An operator's own definitions win.** A mount with anything in it is never written to, so
a corrected role survives every restart and every image upgrade — and an image upgrade does
not overwrite it. To refresh from a newer seed, remove the volume (`docker volume rm
agentdocumentor_agentdoc-agents`) or copy the new files over the old ones. A missing seed
fails the boot rather than starting healthy with zero definitions.

Frontmatter is delimited by `---` and read as `key: value` lines; only `name` and
`description` are used. Host pi-herdsman definitions also carry `tools`, `model` and
`thinking`, and this runtime honors none of them: those keys are ignored with a startup
warning naming the file, so a directory copied from an existing pi-herdsman setup still
loads. The strictness is on the selection instead — `AGENT_DEFINITION=<name>` fails the
boot when the chosen definition carries them, because a definition that is half-honored
is worse than one that is refused, and that is the only one the prompt would apply. At
turn time the same keys are refused more gently: the edit is ignored, the last valid text
is kept, and a warning is logged.

Selecting a definition with `AGENT_DEFINITION=<name>` appends it to the system prompt
as `# Role: <name>`, followed by the description and the body, before the turn's Stack
section. Because the role is appended per turn rather than composed at boot, it lands
after Pi's own `<cwd>` block and before the Stack section, and its content is unchanged.
The base prompt stays first and unmodified, so a role adds to the product's
behavior instead of replacing it. With `AGENT_DEFINITION` unset nothing changes in the
prompt: the plain one is used, and definitions are still read so their problems are
visible at startup.

**Why this loader is ours.** Pi 1.4.0 core has no agent-definition discovery: its
`DefaultResourceLoader` is built with `noExtensions: true` and there is no
delegate/subagent tool, so no runtime path would ever read these files. The server
therefore loads and validates them itself at startup. Every file is read then,
including when no definition is selected, and the boot fails with the file name when a
definition cannot be parsed at all rather than serving a deployment that asked for a
role and did not get it. The per-turn read reuses that same parser
(`src/pi/agent-role.ts`), so a file cannot be strict at boot and lenient later.

#### Correcting a role

In production the definition lives in a volume, so the fix is a file copy — the server
picks it up on the next message:

```bash
docker cp fixed-role.md agentdoc-server:/home/node/.agents/agents/wiki-agentic-search.md
```

Overwrite the selected file in place. The `name:` line inside it is the identity, so the
destination's file name is free — but leave that line alone unless you are also changing
`AGENT_DEFINITION` and restarting, or the edit is refused (see **the identity rule**).

Three rules make that safe to do in a hurry:

- **A broken edit cannot leave the agent without a role.** If the file is missing,
  unreadable or its frontmatter is refused at turn time, the turn runs with the last valid
  text and logs a warning. Fix the file and the next turn uses it.
- **The file grants nothing.** Tools, model and thinking level stay deployment concerns:
  they come from the MCP provisioning and the `AGENT_READ_TOOLS`/`AGENT_BASH`/
  `AGENT_WRITES`/`AGENT_SKILLS` flags, `CHAT_MODEL` and `CHAT_THINKING_LEVEL`. A `.md` that
  could widen its own permissions would be a privilege question in a text file, which is
  the opposite of what this product wants.
- **A role that names an unprovisioned tool says so.** The tools the body mentions are
  compared with the ones the session actually has; a name that is not there is logged and
  shown as a notice in that turn, naming the tool. The turn proceeds — it is a report, not
  a refusal.


### The wiki search role

`server/agents/wiki-agentic-search.md` is a copy of a local pi-herdsman definition:
agentic search over the wiki, choosing between page retrieval and knowledge-graph
traversal in a bounded, self-stopping loop instead of relaying one composed answer. The
reasoning is the original's; the ONE thing rewritten is how it names its tools.

The agent talks to a single MCP host, so the body names its tools the way the model is
handed them — `search_pages`, `query_wiki`, `read_page`, `get_context_pack`,
`list_stacks`, `query_stack` — and not as `mcp__<server>__<tool>`. The qualified form
names a server, so it only works while the deployment keeps that server's name, and
`tenant_mcp.exposed_tools` holds bare names: a prefixed spelling there would match
nothing and quietly grant no capability. A second host (`llmwiki_kg`) is gone with it.
The frontmatter carries only `name` and `description`, because a selected definition
carrying `model`, `thinking` or `tools` fails the boot, and a YAML block list
(`  - item`) fails the parse for every file in the directory rather than loading
silently.

Select it with `AGENT_DEFINITION=wiki-agentic-search`. That SELECTION is a startup fact, so
setting it — or swapping to another definition — needs a restart; the file's text does not.
The file does not set the model or the tools —
those come from `CHAT_MODEL` and `CHAT_THINKING_LEVEL` in the environment, and from the
MCP grant list in `server/scripts/provision-mcp.mjs`. The rule that list follows is
**every read-only tool the shipped role names is granted**, so the role's instructions
can always be followed: a role asking for a tool it does not have is the failure that
matters here. What is not granted is the five tools that **write** to the wiki host —
`ingest_source`, `compile_wiki`, `export_okf`, `import_okf`, `run_eval` — because this
product never decided to expose them. `server/test/provision-mcp.test.ts` pins both
halves: every tool the role names is covered, and no mutating tool is granted.

### Skills

A skill is a `SKILL.md` document — `name` and `description` in its frontmatter, prose
below — that the model may consult. This repository ships two in `server/skills/`
(`llm-wiki-mcp` and `probe-skill`).

Pi writes each skill's absolute `<location>` into the system prompt and expects the model
to open it with `read`. That tool is confined to the workspace, so the only placement
where the body is actually readable is **inside** it: `/data/workspace/.pi/skills`, which
is where Pi discovers project skills. Mounted at `$HOME/.agents/skills` — the user
scope — a skill is listed and then refuses to open with `PathEscapeError: … is outside
the workspace`.

Where that directory comes from differs by stack, and the difference is deliberate:

| | Development | Production |
|---|---|---|
| Source | bind mount of `./server/skills`, read-only | named volume `agentdoc-skills`, seeded from the image |
| Host path read | `server/skills` | **none** |
| Refresh | edit the file in the repo | remove the volume, or copy over it |

**Development** bind-mounts `./server/skills` read-only, so an edit to a `SKILL.md` is
what the next turn sees.

**Production** mounts the named volume `agentdoc-skills` at that path and reads no host
path at all: `docker-compose.prod.yml` plus the two published images is a complete
deployment, and a host that carries neither the repository nor a copy of `server/skills`
still gets the skills.

The image carries a **seed** copy at `/opt/agentdocumentor/skills`, and it sits at neither
discovery scope on purpose: Pi discovers skills at `$HOME/.agents/skills` and
`<cwd>/.pi/skills`, so a copy in either place would list every skill twice under the same
name. `server/entrypoint.sh` copies that seed into the volume on a first boot, when the
mount is missing or empty, and prints one line either way:

```text
skills-seed: /data/workspace/.pi/skills was empty, seeded from /opt/agentdocumentor/skills
skills-seed: /data/workspace/.pi/skills already has content, left untouched
```

**An operator's own skills win.** A mount that has anything in it is never written to, so
copying your skills into the volume — or editing a seeded one — survives every restart
and every image upgrade. The other side of that rule: an image upgrade does not refresh
the skills either. To pick up a newer seed, remove the volume and let the next boot
re-seed it, or copy the new files over the old ones:

```bash
docker compose -f docker-compose.prod.yml rm -sf server
docker volume rm agentdocumentor_agentdoc-skills   # the only operation that re-seeds
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --wait
```

A missing seed fails the boot instead of starting healthy with zero skills — an image
built without `server/skills` is a broken image, and a stack that answers every turn
while consulting no skill is the silent state this arrangement exists to remove.

To see discovery work end to end, use `server/skills/probe-skill`: ask the agent whether
product skills are loaded and it answers `PROBE-SKILL-LOADED` when it managed to read
the file.

### `.env` for a deployment

Compose reads a `.env` beside `docker-compose.yml` and interpolates it into the
service environment, so a deployment is configured in one git-ignored file instead
of a shell export per command. Start from this and keep it `chmod 600`:

```env
# Provider (secret)
CHAT_PROVIDER=synthetic
CHAT_MODEL=syn:large:text
CHAT_API=openai-completions
CHAT_BASE_URL=https://api.synthetic.new/openai/v1
CHAT_API_KEY=sk-...

# Database (secret). Applied only on the volume's first initdb.
POSTGRES_PASSWORD=<48 hex chars>

# How callers are identified. `password` is the default: everyone signs in with their
# own user and password. `DEFAULT_USERS` sets the passwords of the two accounts a fresh
# database gets; leave it out and they are generated at the first boot and printed once
# in the server log. The legacy modes (`open`, `shared-token`, `roster`) still exist for
# the tests, and the web client cannot use them. See "Sign in: a user and a password"
# below.
AUTH_MODE=password
DEFAULT_USERS=alice:<password>,bob:<password>

# External ingest service
INGEST_API_BASE_URL=http://host.docker.internal:4240
PUBLIC_BASE_URL=http://<address the ingest service reaches this server at>:8080

# What the model may do
AGENT_READ_TOOLS=true
AGENT_SKILLS=true
AGENT_BASH=false
AGENT_WRITES=false
```

Three notes that are easy to get wrong:

1. **`POSTGRES_PASSWORD` only takes effect on the volume's first `initdb`.**
   Changing it later leaves Postgres with the old password and the server unable to
   connect. Either change it together with a fresh volume, or run
   `ALTER USER agentdocumentor WITH PASSWORD '...'` inside the container.
2. **`PUBLIC_BASE_URL` must be an address the ingest service can reach**, and
   `INGEST_API_BASE_URL` one this server can reach. A container IP changes when the
   network is recreated; prefer a hostname, or `extra_hosts:
   ["host.docker.internal:host-gateway"]` when the ingest service runs on the host.
3. **`AUTH_MODE` defaults to `password`, and that is the mode to keep.** The legacy
   `open` mode means no authentication: anyone who can reach the server can act as any
   user by sending a header. Only choose it where that is acceptable, behind TLS and
   network restrictions, and never on a host that holds real conversations.

## Sign in: a user and a password

Identity is an account. A person opens the app, types a `User` and a `Password`, and
signs in; the server answers with an `HttpOnly` session cookie, and every later request
carries it. That is the whole model: no email, no token in the link, and no way to be
identified by the URL.

```
http://localhost:8088/?stackId=<stack-id>
```

`?stackId=` chooses the Stack and signs nobody in (see **The Stack comes from the
link**). `?user=` and `?token=` are dead parameters: the client ignores both, and a link
carrying them lands on the sign-in screen like any other URL.

### The two default accounts

A fresh database gets **two** accounts, `alice` and `bob`, created after the migrations
and before the server starts listening, so a new install needs no hand-created user
before the product is usable. Their passwords come from `DEFAULT_USERS`
(`alice:<password>,bob:<password>`):

- **Set**, the value is used as written. A malformed entry — an id that is not
  `[A-Za-z0-9._@-]{1,64}`, a password outside 8–200 characters, or the same id declared
  twice — **stops the boot** and names the entry, because a deployment that seeded
  `alice` and silently skipped `bob` looks healthy and is missing an account.
- **Unset**, both accounts are created anyway, each with a generated password printed
  **once** in the server log at that first boot:

```
default user "alice" created with a generated password — this is the only copy, save
it now: password="…"
```

That makes the log stream sensitive exactly once, so capture it there and then
(`docker compose logs server | grep 'generated password'`) and store the passwords with
whatever holds the deployment's other secrets. It is never printed again: seeding is
`INSERT ... ON CONFLICT DO NOTHING`, so an account that already exists is left exactly as
it is and a changed `DEFAULT_USERS` afterwards has nothing left to do. The tempting
upsert would turn every restart into a silent credential reset for people who are already
signed in.

Everyone has the same permissions: no role, no admin flag, no privileged account. Anyone
signed in can create another account, and ownership of conversations, documents and jobs
stays scoped by `user_id`.

### The endpoints

`POST /api/login` with `{"user":"<id>","password":"<password>"}`:

| Answer | Body |
|---|---|
| `200` | `{"user":{"id":"…","displayName":"…"}}`, plus `Set-Cookie: sid=…` |
| `400 invalid_request` | `user and password are required` — a missing or blank field |
| `401 invalid_credentials` | `User or password is incorrect` |
| `429 too_many_attempts` | `Too many failed attempts; try again later` |

An unknown user and a wrong password answer with the same status, the same body and the
same amount of work (a `scrypt` verification against a dummy hash), so the endpoint
cannot be used to discover which accounts exist.

`POST /api/logout` answers `204` and expires the cookie, whatever arrived: no cookie, a
cookie for a session that is already gone, or a token the server never issued. Signing out
is not something a client should have to succeed at twice.

`GET /api/me` answers `200 {"id":"…","displayName":"…"}` for a valid session and `401`
without one. In password mode `displayName` is the account's own name, not the id echoed
back; in the legacy modes there is no account and the id is the name.

`POST /api/users` with `{"user":"…","password":"…","displayName":"…"}` creates an
account. `displayName` is optional (it defaults to the id, capped at 120 characters), the
id must match `[A-Za-z0-9._@-]{1,64}`, and the password is 8 to 200 characters — never
trimmed, because spaces inside a password are part of it:

| Answer | Body |
|---|---|
| `201` | `{"user":{"id":"…","displayName":"…"}}` |
| `400 invalid_request` | the rule that was broken: the id pattern, the password bounds, or the `displayName` cap |
| `401` | no valid session |
| `409 user_exists` | `User "<id>" already exists` |

The `409` comes from the insert's unique violation and never from a `SELECT` first: two
requests for the same id can both find it missing, and only the database can decide which
one wins. The loser is refused and the existing row is not touched — a duplicate must
never be a silent password reset.

### The session

The cookie is an opaque 32-byte token: `sid`, `Path=/`, `HttpOnly`, `SameSite=Lax`, a
`Max-Age` of 30 days, and `Secure` only when `PUBLIC_BASE_URL` is https (a `Secure` cookie
sent over plain http is dropped by the browser, which turns into a login that silently
never sticks).

It is a bearer secret, so the database stores only its SHA-256 in `sessions.token_hash`;
the plain token goes to the browser and is never written down server-side. Nothing in the
browser keeps a second copy either — no `localStorage`, no `sessionStorage`, no token in
the URL — and `HttpOnly` keeps it away from scripts. Signing out deletes the row, which is
what makes it a revocation rather than a suggestion: from that moment the cookie names
nobody.

### The login throttle

Failures are counted **in memory, per process**: 10 failures for one account lock that
account for 15 minutes and answer `429`. Two consequences are worth knowing before an
operator meets them: a restart resets every counter, and a stack running more than one
server process counts per process, not globally. The lock is a speed bump, not the
brute-force defence — that is a strong password, chosen in `DEFAULT_USERS`.

### The legacy modes

`AUTH_MODE=password` is the default. `open`, `shared-token` and `roster` remain, and they
identify a caller from headers instead of a session:

| `AUTH_MODE` | Identity comes from | Resists impersonation | Needs |
|---|---|---|---|
| `password` (default) | the `sid` cookie of a signed-in account | **Yes** | `DEFAULT_USERS`, or the passwords generated at the first boot |
| `open` (legacy) | `x-user-id` alone | **No** | nothing |
| `shared-token` (legacy) | `x-dev-token` + `x-user-id` | No — one token for everyone | `DEV_AUTH_TOKEN` (≥1 char, shared) |
| `roster` (legacy) | `x-dev-token` resolved to a user | **Yes** | `CHAT_USERS=id:token,...` |

The legacy modes exist for the test suites and for an API deployment that deliberately has
no accounts. **The web client supports `password` only**: it signs in with the cookie and
never sends an identity header, so a stack running a legacy mode answers the browser with
`401` and the app stays on the sign-in screen. Under `open` a name in a header is the
identity, with no secret behind it — anyone who can reach the server can act as any user —
which is a decision somebody takes on purpose, behind TLS and network restrictions, and
never on a host that holds real conversations.

A misspelled `AUTH_MODE` throws at startup instead of falling back to a weaker mode. With
nothing configured at all the server now runs `password`, never `open`: the inference
that still understands the legacy modes cannot fall forward into a mode that refuses
every request it was not given a session for.

### Roster mode, if a deployment chooses it

Roster mode is legacy and **cannot serve the web client** (see above): it exists for an
API deployment that wants a secret per caller. Each person gets a secret the others do not
have, and the secrets live in ONE file:

- `.chat-users`, in the deployment directory beside the compose file that mounts it, holds
  **a single line**: `id:token,id:token,id:token`.
- It is git-ignored (`.gitignore` names it) and should be `chmod 600`.
- Both compose files mount it **read-only** at `/run/secrets/chat-users`, and
  `server/entrypoint.sh` exports `CHAT_USERS` from it at boot — only when `CHAT_USERS` is
  not already set, so a secret injected by an orchestrator still wins.
- It is **never** in `.env` and never in a compose file: those are copied between hosts
  and interpolated into every service that names a variable, and a token is not a setting.
  A mounted file also has one place to rotate and one thing to protect.

Neither compose file defaults to this mode any more: `docker-compose.yml` defaults to
`AUTH_MODE=password`, and `docker-compose.prod.yml` falls back to the same `password` when
nothing sets the variable — `deploy/env.prod.example` sets it too. Choosing roster is
`AUTH_MODE=roster` in `.env` and nothing else, and then a missing `.chat-users` stops the
boot instead of starting a server that refuses every request.

**Token shape.** 16 to 64 characters; 32 hex characters from the OS CSPRNG is what this
repository generates. Shorter than 16 stops the boot (`CHAT_USERS token for "<id>" is too
short`), and so does a misspelled `AUTH_MODE`, because a typo in a security setting is not
a licence to fall back to a weaker mode.

**Onboarding a person** — `dave`, from a checkout of the deployment:

```bash
# 1. a token: 32 hex characters, generated, never typed
node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))'

# 2. add  dave:<that value>  to the single line in .chat-users, and lock the file down
chmod 600 .chat-users

# 3. restart the server so the entrypoint reads the file again
docker compose restart server        # or: docker compose up -d server

# 4. grant their MCP tools, or they chat with none — see the warning below
cd server && USERS=dave \
MCP_SERVER_URL=http://172.17.0.1:4173/mcp \
DATABASE_URL=postgres://... \
node scripts/provision-mcp.mjs       # also reads .chat-users when USERS is unset
```

**Rotating one token** is the same edit with a new value: replace `dave:<old>` with
`dave:<new>` in `.chat-users`, restart, and give the person the new value to send as
`x-dev-token`. The old one stops working at the restart. There is no revocation API and no
expiry, so a rotation IS this edit — nothing else has to be told.

**A roster caller** is `x-dev-token: <his value>`, plus `x-user-id` when it wants to say
who it is: a valid token that claims somebody else answers `401`, and so does a name with
no token. On the API a token alone is enough, because it names its own owner. This is an
API spelling and not a product URL: `?user=` and `?token=` are ignored by the client, and
the browser cannot sign in to a stack in this mode at all.

**The silent state to watch for.** A roster user with no `tenant_mcp` rows chats normally
and simply has **no MCP tools**: no error, no notice, no log line. Step 4 above is the fix.
If a new user reports that the assistant cannot search the wiki or read a Stack, check the
provisioning step before anything else — the identity worked, the grant is what is missing.

### What a person sees

| State | What the person sees |
|---|---|
| `?stackId=<stack-id>` | The sign-in screen, then the product, scoped to that Stack |
| No `stackId` | The sign-in screen, then the product; only the ingest surface asks for a Stack |
| A `?user=` / `?token=` link | The sign-in screen: both parameters are ignored |
| Wrong credentials | `User or password is incorrect` |
| 10 failures in 15 minutes | `Too many failed attempts; try again later` |
| Signed out, or a session that expired | The sign-in screen again, with no error |
| Server down | "Cannot reach the server", with a retry — never an identity error |

**Giving someone access** is creating an account: `POST /api/users` while signed in, then
telling them the id and the password. Everyone has the same permissions, so there is no
role to grant. **Taking it away** is signing them out and deleting their row in `users`;
there is no endpoint for the delete yet, and the two effects are worth knowing: their
sessions cascade away, and their conversations do **not** — those tables predate accounts
and declare no foreign key, so the rows stay and become unreachable.

### Giving a user the wiki tools

Tools are per `user_id`, so a name needs a `tenant_mcp` row before the agent can
read anything:

```bash
cd server
USERS=alice,bob \
MCP_SERVER_URL=http://host.docker.internal:4240/mcp \
DATABASE_URL=postgres://agentdocumentor:<pass>@127.0.0.1:5432/agentdocumentor \
node scripts/provision-mcp.mjs            # --dry-run to preview
```

It is idempotent, and it does not create users — it grants tools to the names you
list. A name that never appears there still opens the product; it simply has no
tools, and nothing says so: no error, no notice, no log line. That is the one silent
state in a roster deployment, and it is why this step is part of onboarding.

`MCP_DEFAULT_STACK_ID` is **deprecated and ignored**. The Stack comes from the
request link (or an explicit tool argument), not from provisioning: setting the
variable still works, prints one deprecation warning, and changes nothing (see
**Which Stack the agent reads**).

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

### The Stack comes from the link

The ingest surface is tenant-scoped, and the tenant is the `stackId` in the URL:

```
http://localhost:8088/?stackId=<stack-id>
```

Every READ — the document list, the job list, an upload — takes that parameter and
nothing else. There is no Stack environment variable, nothing is injected at build
time, and no default is assumed when it is absent; each of those would let one
tenant's jobs be read under another tenant's name. It is read once, at mount, from
`location.search`, beside the `GET /api/me` that decides whether the person is signed in;
it is not stored in `localStorage`, not remembered between visits, and not accepted from a
header or a cookie, so a reload without it is blocked exactly like a first visit.

A WRITE resolves its Stack in one place, in the same order the agent's tools use: the
Stack chosen in the panel wins, and the link's is the fallback. The panel's **Stack**
control is filled from `GET /stacks` — `200 {"stackIds": string[]}`, ids only, and
`{"stackIds": []}` when the service lists none; the same auth as the routes beside
it, additive and read-only, publishing the listing the create path already validates
against — and it is preselected with the link's value, so a user who does not choose
keeps exactly the old behavior. A chosen Stack also scopes the poll of the job that
choice started, because a job created in one Stack cannot be followed in another.

| Link | Ingest surface |
|---|---|
| `?stackId=<stack-id>` | The reads and the prefill carry that Stack, and so does every write while the control is left alone |
| No `stackId`, or empty / whitespace-only | States the missing parameter and issues no READ at all — no list, no upload, no poll. A Stack chosen in the control can still start an ingest |
| Neither the link nor the control names one | No request at all, and the notice below is on screen |

That last state is named, never guessed: with nothing resolved the panel says "This
ingest names no Stack: no Stack was chosen for it and the link names none. Choose a
Stack, or open a link that ends in ?stackId=<stack-id>." and sends nothing — a
request into a tenant nobody named is worse than no request.

The shape is checked before anything is sent: a value that is empty after trimming
is refused without a request. Whether the Stack EXISTS is the service's answer, and
it is shown as it arrives — `400 invalid_stack_id` for a malformed id, `404
stack_not_found` (or the agent's `unknown_stack`) for an id the service does not
know. A rejected Stack is a visible failure with no retry loop, because retrying the
same rejected value can only produce the same answer.

Two consequences of that split are worth knowing in advance. The **Recent** list stays
scoped to the link's Stack, so a job started in a Stack the link does not name shows
its own progress in the detail pane and is not listed there. And a failed `GET
/stacks` degrades silently to the link's value instead of blocking: the control then
offers only that Stack, and the write path is unaffected.

Chat is unaffected: a link without `stackId` still opens the product. Only the
ingest surface is closed, and that is the point — an unscoped read would show one
tenant the jobs of another.

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
| `dimensions[]` reports per-unit results with their own statuses | One row per dimension, each with **its own** badge |

Polling backs off from 250 ms to 2 s and stops as soon as both dimensions settle;
the service streams nothing. A `409 busy` is surfaced as a retry signal, not a
failure, and a read that fails is retried instead of ending the follow (below).

### Staying attached: a reload, a blip and the list

The panel is a window on the job, not a photograph of it, so three things happen
without being asked (`S2`-`S7` of `odd/tasks/ingest-follow-resilience.md`).

| Situation | What happens |
|---|---|
| A read throws, or answers a status other than `404`/`503` | Retried on the same 250 ms → 2 s backoff. The last snapshot stays on screen and the notice says it is reconnecting; the next good read clears it |
| No read succeeds for 90 s | The follow stops with `reason: "error"` and a notice naming how long it went unanswered. The bound is the SAME `STALL_AFTER_MS` window that decides an unmoving job is orphaned — one notion of dead, not two |
| A `404` after a snapshot, or a `503` | Unchanged, on purpose: an expired job and a host that does not track jobs are ANSWERS, not blips, and retrying them would turn them into spinners |
| The panel is open | The **Recent** list is re-read every 5 s. A tick that lands on a read still in flight is dropped rather than queued, and nothing is read while the link names no Stack |
| The panel opens with nothing being followed | The most recently updated job that still has work ahead of it is followed automatically — once per visit |
| The user follows another job, stops the follow, or the adopted job ends | The automation is over for that visit. The screen is the user's |

The re-attach asks the list which job is most recently running: there is no `job=`
parameter and nothing is stored, so a single job is still not shareable by link, and a
page cannot follow one it was never told about. A job whose ingest failed while its
compile still reads `queued` is not adopted either — nothing will ever start that
compile, so following it would only delay the same bad news.

### Per-dimension results

A job payload may also carry a `dimensions` array: the producer's own per-unit results,
beside the two state machines.

```json
"compile": { "status": "succeeded", "message": "Compiled wiki and kg." },
"dimensions": [
  { "name": "wiki", "status": "succeeded", "summary": "wiki:created" },
  { "name": "kg",   "status": "succeeded", "summary": "kg:N chunks, M entities" }
]
```

When that array is there, the detail pane renders the fixed `Ingest` / `Compile` columns
and **one row per dimension** beside them, in the producer's order, with that dimension's
own name, status badge and summary. One case is not drawn again: a dimension whose name
merely repeats a fixed section's (`ingest` / `compile`, trimmed and case-insensitive) gets
no row of its own, because that fixed column already carries it. Every other name is the
payload's — repetition among dimensions included — so a dimension called `kg` or `qa`
renders exactly like `wiki`, and a dimension whose status differs from the job's overall
status keeps its own badge — a failed `kg` is visibly failed even when the compile reads
`succeeded`.

| Payload | What the detail pane shows |
|---|---|
| `dimensions` is usable | The fixed `Ingest` / `Compile` columns, always, plus one row per dimension beside them. The one row not drawn twice is a dimension that merely repeats a fixed section's name (`ingest` / `compile`), which the fixed column already carries |
| Absent, empty, or with nothing in it readable | The fixed `Ingest` / `Compile` columns, exactly as before |

The array is a **report**, not a lifecycle. It never decides when polling stops: a job
ends only when **both** `ingest` and `compile` are terminal, so a dimension that finished
first cannot end the poll, and a job whose dimensions all read finished while its compile
is still running keeps polling. Whether the producer can settle a dimension before the
overall status is unverified, and the poller does not assume either ordering.

A source path is resolved on **the service's** filesystem, not in this container:
a file that only exists here is not a valid source. Use a URL, a path the service
can see, or upload it.

### Controls: delete and retry, and no cancel

Two operator controls proxy the service's own operations. Both carry the same
identity and the same optional `stackId` in the query as the reads beside them.

| Route | What it does |
|---|---|
| `DELETE /ingest/jobs/:id?stackId=` | Deletes a liquidated job; `200`, `202` or `204` on success |
| `POST /ingest/jobs/:id/retry?stackId=` | Re-executes it as a **new** job; the new id is in the body, as `jobId` or `id` |

Both answer the service's refusals verbatim — `404 job_not_found`, `409
job_still_working`, `409 job_changed` — because those are the host's own words for
"this does not exist", "not while it is working" and "you read a stale row"; folding
any of them into `502` would report an operator's answer as a deployment outage. A
refusal is shown as a refusal and never retried automatically.

There is no cancel, and none is invented here: the service has no such operation, and
**delete does not interrupt a running job** — it refuses with `409 job_still_working`
and the job keeps working. Delete and retry share that one guard, so a row can be
re-executed exactly when it can be cleaned up.

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

### CI: one command, and it is the gate

```bash
bash scripts/ci.sh
```

That is the whole gate, and it is the same command GitHub Actions runs — the workflow at
`.github/workflows/ci.yml` checks the repository out and calls it, with no commands of
its own. If it is green on a laptop it is green in CI, because both run the same script,
the same images and the same database.

What it does, in order: builds the **production** images (so a broken Dockerfile fails
the gate); builds the **test** images (`--target test`, which carry the dev dependencies
the runtime images omit on purpose); starts Postgres from this repository's compose file
and waits for a real `select 1`, not for a healthy container; runs `tsc --noEmit` and the
server suite **inside** the test image with `CI_REQUIRE_DATABASE=1`; then runs the web
`typecheck`, suite and production build. Any failure exits non-zero.

Which tiers run where:

| Tier | Locally (`scripts/ci.sh`) | In CI |
|---|---|---|
| Server unit tests, including the Postgres-gated ones | **yes** — `CI_REQUIRE_DATABASE=1` makes an unreachable database a failure, not a skip | **yes**, same image, same flag |
| Web typecheck, tests and build | **yes** | **yes** |
| Live-model tests (a real provider answering a real turn) | only if `PI_AGENT_DIR` holds credentials; otherwise this tier **skips by decision** | **skipped**: CI has no Pi credentials and nothing here invents them |

A tier that skips is not proof: that is why the database tier is required rather than
merely available, and why the table above names the one tier CI does not cover.

How the skip is decided, because it used to be decided by the wrong thing. `scripts/ci.sh`
creates an **empty directory it owns** with `mktemp -d`, passes it as `PI_AGENT_DIR` to the
test container at the same path, and removes it in its `EXIT` trap. It does not name a
missing absolute path: pi-coding-agent *creates* the directory it is handed, so a path the
running user cannot write turned the skip into `EACCES` and four failing tests on any
host running as itself, while staying green in the image because that stage runs as root.
And the skip signal is the **content** of the auth file, not its existence —
`AuthStorage` writes `{}` into the directory it is given, so existence alone read as
"credentials" and the tier ran and failed instead of skipping. An absent, empty,
whitespace-only or `{}` file means no credentials; any non-empty object means configured;
a file that is present but unparseable counts as configured, so a broken credential file
fails the tier loudly instead of quietly skipping it.

The database needs no secret: `scripts/ci.sh` uses the credentials `docker-compose.yml`
already declares for the dev stack, so there is nothing to store in a repository setting.
The database is left running after a local run for inspection; `docker compose down`
removes it.

## Production (containers)

Two paths, and they no longer share one file. **Development builds from source;
production consumes a published image.** Mixing them is how an arm64 host ends up
recompiling instead of using the arm64 image that was actually tested.

### Building and publishing both architectures

`latest` is the production tag, and the build is plain `docker buildx` — no wrapper script.
Both services go up as one multi-arch manifest list under that single tag:

```bash
# 1. local multi-arch manifest build (both services, not published)
docker buildx build --builder multibuilder --platform linux/amd64,linux/arm64 \
  -f server/Dockerfile -t ghcr.io/your-user/agentdocumentor-server:latest --load server
docker buildx build --builder multibuilder --platform linux/amd64,linux/arm64 \
  -f web/Dockerfile    -t ghcr.io/your-user/agentdocumentor-web:latest    --load web
```

`--push` publishes instead of loading, and requires `REGISTRY`: a push has no namespace
to land in otherwise, and a guessed one publishes into somebody else's account.

```bash
REGISTRY=ghcr.io/your-user
docker buildx build --builder multibuilder --platform linux/amd64,linux/arm64 \
  -f server/Dockerfile -t "$REGISTRY/agentdocumentor-server:latest" --push server
docker buildx build --builder multibuilder --platform linux/amd64,linux/arm64 \
  -f web/Dockerfile    -t "$REGISTRY/agentdocumentor-web:latest"    --push web
```

One platform at a time, for the arch you are on or for a daemon that cannot load a
manifest list:

```bash
docker buildx build --builder multibuilder --platform linux/arm64 \
  -f server/Dockerfile -t "$REGISTRY/agentdocumentor-server:latest" --load server
docker buildx build --builder multibuilder --platform linux/arm64 \
  -f web/Dockerfile    -t "$REGISTRY/agentdocumentor-web:latest"    --load web
```

`--load` of a manifest list needs containerd's image store; if the daemon reports none,
use the single-platform form above or `--push`. The `multibuilder` builder is a one-time
setup:

```bash
docker buildx create --name multibuilder --driver docker-container
```

One tag holds `linux/amd64` **and** `linux/arm64`; the consuming host resolves its own
architecture and knows nothing about this.

`latest` is what runs. That is the trade: the tag alone no longer identifies a
deployment, because the next publish moves it and nothing in the tag says which build it
replaced. `deploy.sh` resolves and prints the **digest** of each image between `pull` and
`up`, and that digest — not the tag — is the only exact reference to what actually ran.
See **Rollback** below for what to do with it.

Verified on this machine, not assumed:

| Check | Result |
|---|---|
| Both images build for arm64 | `buildx --platform linux/arm64` succeeds for server and web |
| The server runs natively on arm64 | `process.arch` = `arm64` under qemu, config and auth load |
| The web bundle builds on arm64 | esbuild and rollup resolve their platform binaries |
| No native bindings of our own | **zero** `.node` files mapped in the runtime |
| Base images are multi-arch | `node:22.23.2-alpine`, `nginx:1.27-alpine`, `postgres:16-alpine` |
| Same tag, two architectures | `docker run --platform linux/amd64` and `linux/arm64` both from `:latest` |

`scripts/build.sh` still exists and still builds the same two images, but the commands
above are the documented path; the script is kept for reference and may be removed.

### Deploy: one command

`./scripts/deploy.sh` is the recommended path: it validates `.env.prod`, pulls the
`latest` images, then runs `docker compose -f docker-compose.prod.yml up -d --wait`.
It is the validation and healthcheck-gated path, and it exists because two of the
failures below cannot be corrected after the fact — a placeholder
`POSTGRES_PASSWORD` is baked into the volume on the first `initdb`, and a placeholder
key leaves the stack looking healthy while every turn fails — so every check runs
*before* a single docker command, and `--wait` is what makes "deployed" mean
"healthy".

```bash
cp deploy/env.prod.example .env.prod && chmod 600 .env.prod
$EDITOR .env.prod              # POSTGRES_PASSWORD (openssl rand -hex 24), CHAT_API_KEY

./scripts/deploy.sh --check    # dry validation: no docker command, no file written
./scripts/deploy.sh            # pull, then up -d --wait (healthcheck-gated)
```

Invoking compose by hand is also a supported production path. The flag is not
optional:

```bash
# recommended
./scripts/deploy.sh

# manual, equivalent — --env-file is required
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
```

Without `--env-file`, compose reads the **development** `.env` and the stack can
start with development credentials. The manual form also skips the validation above
and returns as soon as the containers are created: nothing there waits for health.

`.env.prod` is git-ignored (`.env.*`). With no `.env.prod` the script copies the
template, refuses to deploy and exits non-zero; `--env-file <path>` reads another
file instead. `--wait` waits for the healthchecks this compose file declares rather
than sleeping, and a failed start prints the exit status plus the last 40 log lines.
Every validation message names the variable and never its value.

| Variable | If it is missing or wrong | Effect |
|---|---|---|
| `POSTGRES_PASSWORD` | `${POSTGRES_PASSWORD:?}`, still a placeholder, or containing `@ : / # ? %` or a space | **aborts**: `deploy.sh` refuses, because the value is interpolated into `DATABASE_URL` and is baked into the volume on the first `initdb` |
| `CHAT_API_KEY` | empty or still `CHANGE_ME` | **aborts** in `deploy.sh`: the server starts, then every turn fails with `No API key found for the selected model` |
| `CHAT_THINKING_LEVEL` | not one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | **aborts** at startup: `config.ts` throws |
| `PUBLIC_BASE_URL`, `INGEST_API_BASE_URL` | not an absolute http(s) origin, or carrying a path | **aborts** at startup: `config.ts` throws |
| `VERSION` | — | **no effect**: nothing requires it and nothing reads it. The images are tagged `latest`; the digest `deploy.sh` prints is what identifies the build. Set it and it is simply unused |
| `PI_WORKSPACE_DIR`, `CHAT_PROVIDER`, `CHAT_MODEL`, `PI_AGENT_CONFIG_MODE` | empty in `.env.prod` | **no effect**: the compose file supplies all four (`/data/workspace`, `synthetic`, `syn:large:text`, `generate`); an entry here is ignored, and `deploy.sh` warns instead of pretending otherwise |
| `REGISTRY` | empty | **required to pull**: a deployment consumes registry images, so on a fresh host this is the variable that makes `pull` possible. Empty is allowed and selects local images, but then `agentdocumentor-server:latest` and `agentdocumentor-web:latest` must already exist on that host |
| `INGEST_API_BASE_URL` | empty (allowed) | degrades: uploads keep working, ingest-by-document answers `503 ingest_not_configured` |
| `PUBLIC_BASE_URL` | empty (allowed) | degrades: upload-backed ingests are disabled |
| `AUTH_MODE` | `password` in `deploy/env.prod.example`, which is the template `deploy.sh` copies, and `password` again is the fallback in `docker-compose.prod.yml` when nothing sets it; `roster` there takes an explicit `AUTH_MODE=roster` | `password` needs no extra file: the two default accounts are seeded at the first boot. The legacy `open` degrades: a name in a header IS the identity, with no secret behind it. `roster` with no roster file **aborts** the boot, and the web client cannot sign in to it |

`PI_AGENT_CONFIG_MODE` is the one that looks optional and is not: `config.ts` aborts
when the mode is anything but `generate` **and** `PI_AGENT_DIR` is empty, which is why
the compose file pins `generate` — that is what lets the server write its own
`models.json` from the `CHAT_*` variables with nothing mounted.

The images themselves come from **Building and publishing both architectures**
above: `deploy.sh` pulls them and never builds them.

### Skills in a deployed stack

A deployed stack reads no host path. Skills are a named volume, `agentdoc-skills`,
mounted at `/data/workspace/.pi/skills` — the one place the model's confined `read` can
open a `SKILL.md` body. It starts empty and the image seeds it on the first boot:
`server/entrypoint.sh` copies the image's seed (`/opt/agentdocumentor/skills`) into the
volume only when the volume is missing or empty, chowns it to `node` when running as
root, and logs which of the two happened. Details and the reasoning are under **Skills**
above.

Two consequences worth knowing before an upgrade:

- **A non-empty volume is never overwritten.** Skills you copied in, or edited, are yours
  and survive restarts and image upgrades. To re-seed, remove the volume:
  `docker volume rm agentdocumentor_agentdoc-skills` (with the server container
  removed first), then `up -d`.
- **It is a volume, so `down` keeps it and `down -v` deletes it.** A plain `down` leaves
  the seeded skills in place; `docker compose -f docker-compose.prod.yml down -v` removes
  `agentdoc-skills` along with the database and the workspace, and the next boot seeds it
  again from the image.

### Rollback

`latest` is what runs, so a rollback is a digest operation, not a tag operation. Deploy
prints the two references; each one is the exact image that host is running:

```text
  rollback: docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --no-deps --force-recreate server
            image:    ghcr.io/your-user/agentdocumentor-server@sha256:9f2c…
            pin first: docker tag ghcr.io/your-user/agentdocumentor-server@sha256:9f2c… ghcr.io/your-user/agentdocumentor-server:latest
```

`docker compose` reads the tag from the compose file and never accepts a digest on the
command line, which is why `deploy.sh` prints the `docker tag` step: pinning the digest
back onto `:latest` and then recreating the service puts back exactly what ran, with no
pull to overwrite it. A version-pinned tag in `docker-compose.prod.yml` remains the
stronger guarantee if you ever want it back — the cost is that every host then has to
carry the version it should run, which is the thing `latest` removes.

If `deploy.sh` reports `(digest unavailable — pin a version tag for a rollback
guarantee)`, the image was not in the local store with a registry digest (a locally
built image, for instance): there is nothing to roll back to by digest, and the tag is
all you have.

`docker-compose.prod.yml` has **no `build:` key at all**, so it cannot compile
anything even by accident. It also requires `POSTGRES_PASSWORD` rather than
defaulting it, and publishes only `127.0.0.1:8088` — a reverse proxy with TLS is
what exposes it.

### The development stack

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
docker compose down               # stops, keeps conversations and volumes
docker compose down -v            # DANGER: see below before using -v
node scripts/smoke.mjs            # 8 acceptance checks against the running stack
```

**`-v` removes BOTH volumes, not just the database.** `docker-compose.yml` declares
`agentdoc-pgdata` (the database) *and* `agentdoc-workspace` (the agent's workspace).
`down -v` deletes the pair; there is no form of it that removes only the database. To
reset just the database, name it:

```bash
docker compose rm -sf postgres && docker volume rm agentdocumentor_agentdoc-pgdata
docker compose up -d postgres     # recreated from this file's own credentials
```

The container is self-contained: it generates its own Pi model configuration from
`CHAT_*` variables and mounts nothing from the host. `scripts/up.sh` takes the key
(and the api type and base URL) from `~/.pi/agent/models.json` so you do not retype
them; the file itself is never mounted.

### Dev vs production at a glance

| | Development | Production |
|---|---|---|
| Command | `source scripts/dev-env.sh` + `npm start` | `./scripts/deploy.sh` |
| Compose file | `docker-compose.yml` (`build:`) | `docker-compose.prod.yml` (`image:`) |
| Where it builds | on this machine, from the source tree | nowhere — the image is pulled |
| Architectures | whatever this machine is | `linux/amd64` **and** `linux/arm64`, one tag |
| Client | Vite dev server on :5173 (HMR) | nginx static build on :8088 |
| Server | local Node on :8080 | container, no published port |
| Database | container, port 127.0.0.1:5432 | container, private network |
| Pi config | generated into `/tmp`, beside the workspace | generated into the data volume, beside the workspace |
| TypeScript | run directly by Node | run directly by Node (same) |
| Restart policy | none | `unless-stopped` |

Both paths run the same source: there is no build step for the server, because Node
executes the TypeScript directly. What differs is where the image comes from, and
that is the whole reason the two compose files exist.

## Client

React 19 + Vite. Identity is the session cookie, so the client stores no token: a person
signs in at the sign-in screen (`User`, `Password`, `Sign in`) and the browser holds the
`sid` cookie from then on. `web/src/lib/session.ts` is the whole session client —
`fetchIdentity`, `signIn`, `signOut` — and `App` asks `GET /api/me` once on mount to decide
between the loading state, "Cannot reach the server" with a retry, the sign-in screen and
the product. The ingest tenant is read differently: once, at mount, from
`location.search`, by `web/src/lib/tenant.ts`.

One consequence worth stating: no secret travels in the URL any more, so the access log
holds no credential and the query string carries only `?stackId=`. The cookie is
`HttpOnly`, which keeps it away from scripts; it is a bearer token all the same, so put
TLS in front of this stack — a plain-http deployment sends it in the clear.

Text is rendered as text, never as HTML: model output is untrusted input.
The SSE parser is hand-written because a chunk boundary can fall inside a frame,
inside a JSON string, or between the two newlines that end a record; assuming one
chunk equals one frame works in development and corrupts long replies.

A conversation opens at its LAST message, and the transcript keeps following an
answer only while the reader is at the bottom: scrolling up is respected, and
content that arrives while they are away is announced by a control named "Jump to
latest message" instead of moving them. The rule is a pure position check with a
24px tolerance in `web/src/lib/stick-to-bottom.ts`, which is why it is testable
without a browser; whether the browser actually lands on the pixels it asked for
is not, so that part is eyeballed.

Vite is pinned to 7.x because `@vitejs/plugin-react` does not support Vite 8 yet.
Installing Vite 8 fails on a peer conflict; do not paper over it with
`--legacy-peer-deps`.

## Acceptance: isolation and concurrency

`server/test/isolation.test.ts` is the MVP's definition of done. It builds its
server with `AUTH_MODE=roster` and **one token per user**, so every request it makes
carries that user's own secret: what it verifies is data-layer ownership with distinct
identities, not under a harness that trusts a header. (That mode is legacy; the ownership
predicates it exercises are the ones every mode shares, and password mode pins its own
identity rules on top.) It defaults to 2
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

**What this file cannot tell you.** The ownership predicates it exercises are what stop
one *legitimate* user's data appearing in another's sidebar; they are tested here with
two different secrets, which is as far as a test can go. What no test can settle is how
the operator handed the credentials over: a password pasted into a chat message is a
password in a chat message, and one reused from somewhere else is worse. The claim the old
`SKIP` here used to leave open is an assertion now — `scripts/smoke.mjs` proves that a name
in a header signs nobody in and that one session's cookie cannot claim another's id. The
ownership tests need a reachable Postgres and skip without one — a skip is not a pass.

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
`read`, `grep`, `find` and `ls` are available to it, and skills are mounted inside the
workspace at `.pi/skills`, so the same `read` can open a skill body. **All of them are
confined to the workspace**: `read` through its own read operations, and `grep`, `find`
and `ls` — plus `write` and `edit` when `AGENT_WRITES` is on — by refusing a `path`
argument that resolves outside the workspace, before the tool touches the disk. Absolute
paths, `..` traversal, directory symlinks, a symlink whose name looks contained and a
symlink pointing at a file that does not exist are each refused with the same vocabulary,
and a refused `write` creates nothing. `bash` is **NOT** confined by any of this: a shell
reaches whatever the process can reach, and enabling it re-opens the hole regardless of
the checks above. It is off by default for that reason. None of the confined tools
appears in the interface. See **Skills** under **Agent definitions** for where the files
come from.

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
   dispose. Every request on that client carries `MCP_REQUEST_TIMEOUT_MS` (default
   120 s, reported once at startup); a tool that outlives it comes back to the model
   as an `isError: true` tool result rather than failing the turn.
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

## Provisioning the MCP tools

`tenant_mcp` is per user, so the external MCP server has to be granted to each one:

```bash
cd server
USERS=alice,bob \
MCP_SERVER_URL=http://172.17.0.1:4173/mcp \
DATABASE_URL=postgres://... \
node scripts/provision-mcp.mjs            # --dry-run previews, --skip-drift-check skips the host check
```

It takes the ids from `USERS` (or `CHAT_USERS=id:token,...`, or a legacy
`.chat-users` file), upserts one row per user, and is idempotent: running it twice is
the same as running it once, and a corrected `MCP_SERVER_URL` replaces the old
address instead of adding a second server. It grants tools; it does not create
accounts. Under the default `AUTH_MODE=password` an account is a row in `users`, made by
`POST /api/users` or by the seeding, so list the ids that already exist there: a grant for
an id nobody can sign in as is a grant nobody can use.

Before touching a row it asks the host `tools/list` and refuses to write a list the
host cannot honour:

```
3 user(s)  provisioned with 12 tool(s).
Host publishes 17; all 12 granted tool(s) exist. 5 left ungranted
(compile_wiki, export_okf, ingest_job_delete, ingest_source, run_eval).
```

A granted name the host does not publish is an **error, before any write**: the
runtime intersects `exposed_tools` with each server's own tool names, so such a row
reads as granted in the database and grants nothing — the "provisioned 11 tool(s)"
line that used to be printed was counting a capability that did not exist. Tools
left ungranted are reported as a count, not a failure: withholding writes is the
point of the list. `--skip-drift-check` exists for an unreachable host and says so
on stderr when used.

**The script ships inside the server image** (`server/Dockerfile`: `COPY scripts
./scripts`), because a deployed host has no source tree. That copy is a fork: an
image built before the grant list changed keeps the old list, and running it writes
grants for tools the host no longer publishes. It cannot say so — the copy predates
the check. So, in order of preference:

1. **Run the one from the checkout.** It is the source of truth, and Postgres is
   published on loopback for exactly this (see `docker-compose.prod.yml`).
2. **Copy it into the running container** when there is no checkout on the host:
   `docker cp server/scripts/provision-mcp.mjs agentdoc-server:/app/scripts/ && docker exec
   -e USERS=… -e MCP_SERVER_URL=… agentdoc-server node /app/scripts/provision-mcp.mjs`.
   This survives nothing: the next `up --force-recreate` or `pull` restores the
   baked copy.
3. **Rebuild and republish the image**, which is the only permanent fix for the baked
   copy. See *Building and publishing both architectures*.

Nothing runs the script automatically — not `entrypoint.sh`, not the compose file —
so a stale copy only causes damage when a person runs it. That is the reason this is
a documentation problem until the image is rebuilt, and a silent-write problem when
it is not.

`MCP_DEFAULT_STACK_ID` no longer appears in that command. It is **deprecated and
ignored**: still tolerated, still warned about once per run, never read. A stored
`tenant_mcp.default_stack_id` from an earlier run is left exactly as it is and is
never consulted, so nothing needs cleaning up — and re-running this script neither
resurrects nor destroys it.

It grants twelve tools, all of them reads:

- **Stack reads** — `list_stacks`, `query_stack`, `traverse_stack`, `get_entities`.
  All take a `stackId` and read exactly one Stack, so the scope gate knows they are
  Stack-scoped by name. The last three are the graph dimension: entity lookup by
  description, neighborhood traversal from a named entity, and inventory.
- **Ingest jobs** — `ingest_jobs_list`, `ingest_job_status`. Status about work already
  running, never a new job.
- **Wiki reads** — `query_wiki`, `search_pages`, `read_page`, `get_context_pack`,
  `wiki_status`, `lint_wiki`.

`verify_artifact` used to be granted and no longer is: the host stopped publishing it
(the 2026-11-18 build lists seventeen tools and that is not one of them), and a grant
for a tool that does not exist is silently dropped by the intersection — granted in the
database, nothing granted in practice.

The five tools that **write** to the wiki host — `ingest_source`, `compile_wiki`,
`export_okf`, `import_okf`, `run_eval` — stay out: exposing them would allow operations
this project never decided to permit. The grant list is every read-only tool the shipped
role names, so the role's own instructions always have the tools they ask for.

Without this step the agent sees no Stack tools, and it cannot answer questions
about Stacks.

### Which Stack the agent reads

The Stack an agent tool call reads is the `stackId` from the page's link: the page
forwards it as `x-stack-id` on the turn request, and the MCP proxy reads it per call.
It is a SELECTION of which Stack to read, never an authorisation — no entitlement is
derived from it and nothing is stored with the conversation. Any signed-in caller can set
it, exactly as they can pick a Stack in the ingest panel.

A link without `stackId` therefore cannot use the wiki tools BY FALLBACK: a
Stack-scoped call that names no Stack fails closed with a visible error naming the
link form, because the alternative — calling with no Stack — reads whatever tenant
the remote endpoint happens to be bound to. That is why the provisioning variable
above is gone rather than defaulted.

The order the proxy applies is: an explicit `stackId` in the tool's arguments WINS,
the link's Stack is the FALLBACK when that argument is absent or blank, and with
neither the call is refused and nothing reaches the upstream. A call that overrides
the turn's Stack is a choice, not a contradiction, so it is forwarded rather than
refused — and it is not silent, in either of the two places a divergent call can be
noticed. The person whose turn it was reads it in that turn's own output, under the
answer:

| The call was sent to | What the chat window says |
|---|---|
| a Stack other than the link's | `<tool> was sent to Stack <argument's Stack>, not the session's Stack <link's Stack>.` |
| a Stack the argument named, with no Stack in the link | `<tool> was sent to Stack <argument's Stack>; the session had no Stack.` |

The sentence says what the proxy SENT, not what the host did with it: whether the remote
service honours a per-call `stackId` is unproven from this repository — a host that binds
its Stack at MCP `initialize` or from its own process environment would ignore the
argument — so the line reports the forwarding it can see and claims no outcome.

Each divergent call gets its own line, and the line names the tool: two calls that left
the link's Stack for the same foreign one are two facts, not one, and a sentence naming
no call would leave a reader unable to tell which call it describes.

and an operator reading the log gets one structured record per overridden call,
naming the tool, the turn's Stack and the argument's Stack. Nothing is shown when the
argument names the link's Stack or when the argument is absent: neither is a
divergence. This supersedes the earlier rule that refused any argument disagreeing
with the link; nothing is refused for disagreeing now.

The model also reads the Stack directly, so "ingest this into my stack" resolves
without asking which one it means. Every turn's system prompt names the link's Stack,
says that "my stack", "this stack" and "the stack" mean it, and says that a
stack-scoped tool omitting `stackId` applies it. The value is resolved per turn from
the request's own context — the same `stackId` the tool proxy reads — and is projected
onto the provider request only: it is never stored, never added to the conversation and
never shown in the chat, and two turns running at once cannot see each other's. A link
without `stackId` adds no section at all, leaving the fail-closed error above as the
only statement about the missing Stack. The resolution order is untouched: the section
states the default, an explicit argument still wins, and a divergence is still reported.

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
