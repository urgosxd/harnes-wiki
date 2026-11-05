# Feature: multitenant-stackId

The tenant StackId stops being deployment configuration and becomes request-scoped
context carried by the link. The ingest surface resolves it from the URL at mount and
names it on every read and write; the Stack picker and its silent default are gone.

Status: complete
Branch: `feature/multitenant-stackId`
Created: 2026-10-28
Requester: llm-wiki-compiler (peer feature of the same name, delivered as D1-D6)

## Supersedes (do not rewrite history)

`odd/tasks/pi-chat-mvp.md` keeps its history untouched. Within it, these entries are
amended or superseded by this feature:

| Entry | What it established | Now |
|---|---|---|
| T15 | Stack picker fed by the agent's `list_stacks` | Superseded: no picker, no `list_stacks` read in the browser |
| T16 | `?stackId=` on the job reads, so the picker filters | Amended: the parameter stays and is the ONLY source; it is no longer a filter over a default |
| T30 | The picker controls destination; guard replaced | Superseded: destination comes from the link, `checkCreateTarget` removed |
| T31 | Server-side refusal of a Stack the service does not know | Kept as-is: the server still validates; the browser now surfaces that answer instead of pre-validating |

## Specs

S1. The requester's original request, verbatim:

> "Se acaba de crear una feature que es multitenant-stackId, que simplemnte ya no es necesiria la variable env de StackId, asi que el Agente en su frontEnd no necesita implementarlo, asi que se gestionara via parameterUrl asi al ingestar como se requiere del StackId se sacara el StackId de ahi"

S2. Verbatim: "el frontend debe resolver StackId desde el parametro de URL; no desde una env var, no desde un picker, y no desde un default implicito"

S3. Verbatim: "si el parametro falta o es invalido, la ingesta falla de forma visible, sin default silencioso"

S4. Verbatim: "sin un StackId valido en el link no hay lecturas: ni lista de jobs, ni poll, ni create"

S5. Verbatim: "`stackId`, a query parameter on the application link, read once at mount from `location.search` next to `?user=`. Full form `?user=<name>&stackId=<stack-id>`." and "Do not persist it to localStorage, do not remember a previous value, and do not accept it from a header or a cookie: the link is the only source, so a reload without the parameter is blocked." Missing, empty, or whitespace-only after trim blocks the ingest surface with a visible error naming the missing parameter.

S6. Verbatim: "Invalid means: shape check in the browser (non-empty after trim), then send the link value and surface the server/upstream answer visibly (`400 invalid_stack_id`, `404 stack_not_found` / `unknown_stack`, already forwarded). Do NOT pre-validate against `list_stacks` and do not resurrect `defaultStackId()`. Ingest must not be coupled to a model turn. While the state is unresolved, keep the ingest actions disabled and the failure visible; no retry loop on a rejected StackId."

S7. Verbatim: "Frontend strict, server keeps `stackId` optional. Do NOT make the API reject a missing StackId" — "`server/test/ingest-adapter.test.ts:481` plus `server/test/mcp-http-seam.test.ts:332` document that behaviour. Those tests stay green as-is. `server/src/api/ingest-routes.ts` stays untouched."

S8 (unit 2, replaces the stored default as the injection source). Verbatim: "Retirar MCP_DEFAULT_STACK_ID propagando el stackId del link hasta el tool call, con fail-closed cuando no hay contexto de Stack: la llamada del agente falla de forma visible en vez de leer un Stack compartido."

S9. Verbatim: "el contexto de Stack viaja por request, sin persistencia y sin default: sin contexto, la tool call del agente falla de forma visible"

S10. Verbatim: "el Stack del link gana sobre cualquier stackId que nombre el modelo, y un conflicto se bloquea con error visible en vez de reescribirse en silencio" — three cases: model omits it and context exists ⇒ inject the link's Stack; model passes the same value ⇒ inject it, no error; model passes a different value ⇒ blocked with an `isError` result naming the conflict and no upstream call.

S11 (transport). `x-stack-id` is forwarded by this product's own SPA to this product's own server, shape-validated (trimmed; empty ⇒ no context), **the header is never stored**, and it is never logged with content. It is a SELECTION, never an authorisation: the server derives no entitlement from it, and under `AUTH_MODE=open` any caller can set it — the same caller can already claim any `x-user-id`.

Restated after the verification pass: the HEADER is never stored. The Stack the proxy injects does then appear in the assistant's tool-call arguments, and whole `SessionEntry[]` are persisted verbatim (`server/src/pi/session-factory.ts:202-208` → `server/src/db/conversation-store.ts:186-203`). That is pre-existing behaviour, unchanged by this feature, and the earlier wording claimed more than the code does.

S12 (concurrency, named risk). Two turns started concurrently with different Stack contexts must each see their own value on every tool call, with no bleed, because the tenant runtime is shared per user (`server/src/main.ts:87,110-116`).

S13 (scope guard). No hard gate on the chat surface in this unit: without a `stackId` in the link, Stack-scoped agent tools fail closed and the error text names the missing Stack, and the README states that consequence next to the deprecated variable line.

S15 (B1, the scope gate — binding, and the reason it is not a heuristic). A tool is Stack-scoped **iff** its published schema is unreadable or of unknown shape, OR it is a readable flat object whose `properties` include `stackId`. It is NOT Stack-scoped **only** when the schema is a readable flat object with `properties` present that does not include `stackId`. Absent `properties`, `additionalProperties: true`, `allOf`/`anyOf`/`oneOf`/`$ref`, and anything nested or composed are all UNKNOWN ⇒ scoped. A `stackId` declared under `properties` at ANY depth counts as declaring it — a filter object is the obvious shape — and the scan is bounded by a depth cap with a visited guard, where "the cap stopped me" is UNKNOWN, never "there is none". The argument for unknown-is-scoped is PARITY: the baseline injected a Stack into every call without reading the schema, so this rule can only narrow the read scope relative to that baseline, never widen it.

S16 (A1, the name rule — binding). A tool is Stack-scoped **iff** (a) its schema is unreadable or of unknown shape, OR (b) its schema declares `stackId`, OR (c) its name is in `STACK_TOOLS`, the constant this repository already maintains at `server/scripts/provision-mcp.mjs:127`. Clause (c) is not new knowledge about another service: that constant is the thing that already GRANTS those tools at provisioning time. At host build `6b83fbad88169caf5a6b4e8c173c193465c849c8` (llmwiki `1.4.0-dev.20260919`, `127.0.0.1:4577/mcp`) all 14 tools declare a `stackId` property, `list_stacks` included, and `list_stacks` is the one that declares no `required` array — so rule (b) covers it today, and clause (c) is retained as defence in depth for a host build that stops declaring `stackId`. That is a measurement of that build, not a contract. A Stack is a selection, never an authorisation (S11), so an unscoped listing is not a disclosure to reason about: the listing enumerates the Stacks the endpoint can reach, which is intended at the endpoint/API-key boundary and is how a client offers a choice. With a context the tool now receives a `stackId` its schema does not require; the baseline did exactly that in production, and if upstream ever rejects it the tool fails visibly instead of reading unscoped.

S17 (F2, ambiguous header — binding). A duplicated or joined `x-stack-id` means NO context, never the first value: Node joins two header lines into `"a, b"`, and slicing that string would let a malformed request choose a Stack. The array branch is kept and also yields no context. Guessing costs a cross-tenant read; refusing costs one visible tool error. The same pre-existing shape at `server/src/api/routes.ts:145` (idempotency key) and `server/src/http/auth.ts:82-85` is out of scope and reported, not fixed.

S18 (F3, non-string `stackId` — binding). A `stackId` that is not a string is a TYPE problem with its own message naming the expected type, not a conflict between two Stacks. The conflict branch is reserved for two real strings, and no branch reaches the upstream with a non-string value.

S20 (B2, path independence — binding). The gate must not depend on the directory it is checked out into. The compose project is pinned (`COMPOSE_PROJECT_NAME`) and the network name is DERIVED from `docker compose config`, never written as a literal; cleanup uses `down` without `-v`. Proven by running the whole script from a copy of the repository at a different directory name (`/tmp/ci-proof/harnes-wiki`) and requiring exit 0, and guarded by a test that no `*_internal` literal returns.

S21 (B1-DOC, documents that lie) — RESTATED to say what it actually covers. The guard evaluates exactly ONE table: `multitenant-stackId.md`'s five-column task table, 29 rows when this was written. The other four documents in `odd/tasks/` contribute zero rows and their `Status: in progress` headers are never compared, because their tables have no commit cell at all — decision logs (`# | Decisión | Motivo`), evidence logs (`Fecha | Task | Evidencia`), commit narrations (`Commit | Contenido`) and measurement tables. `pi-chat-mvp.md` records its tasks in a long evidence table with SHAs inside prose, which is not a task-commit table. So: S21 governs one document, and the rules are (a) a row whose commit cell names a SHA may not read `pending`, (b) rows and header must agree about what is pending in BOTH directions, and (c) a census sentinel fails if any table shaped like a task table — a task id in front, a commit at the end — is not evaluated, or if a second document starts carrying task rows. That last clause is what stops a third table shape from slipping in unread.

S22 (false green). A test that needs only a database must not be gated on model credentials: tenancy isolation is a database property, and gating it on Pi credentials meant CI would run zero isolation assertions while the README called the skipped tier live-model. The two gates are separate, and each skip message names the requirement that is actually missing.

S23 (workflow hygiene and the destructive hint). One run per branch with `cancel-in-progress`; and where the README shows `docker compose down -v`, it states that `-v` removes BOTH volumes and gives the named form that resets only the database.

S19 (accepted breadth). `x-stack-id` travels on every request from this product to its own server, not only on the ingest and turn routes. Harmless: the header is a selection our own server reads where it matters, and varying it per route would add a second code path for no security gain.

S14 (unit 3, the S6 residual). The upstream message must reach the screen, not only its status code: `400 invalid_stack_id` has to read as "'not-a-stack' is not a Stack id", not "request failed with 400". Implemented as an INGEST-LOCAL formatter that prefers `body.error.message` from our envelope and delegates its fallback to `errorFrom` unchanged. `errorFrom` itself is not modified — it is shared with chat and every other call, so rewriting its copy would be an unrequested shared-behaviour change. Zero blast radius outside ingest, no duplicated parse logic, chat copy byte-identical by construction.

## Tasks

| ID | Task | Spec | Route | Commit |
|---|---|---|---|---|
| T1 | Feature document and the supersede record | S1 / D5 | inline | `0f55329` |
| T2 | Link parsing module (`web/src/lib/tenant.ts`) with its unit tests | S5, S2, S3 | worker `stackid-link-resolution` | `490bef0` |
| T3 | Ingest hook resolves the StackId from the link and issues zero requests while blocked | S2, S3, S4, S6 | worker | `490bef0` |
| T4 | Panel loses the picker; the blocked state is the only thing it renders | S2, S3, S4 | worker | `490bef0` |
| T5 | Dead picker machinery removed (`stacks.ts` and its tests) | S2 | parent (`git rm`, the worker's policy forbids deletion) | `490bef0` |
| T6 | Public-surface tests for the four rules the requester named | S3, S4, S6 | worker | `490bef0` |
| T7 | README describes the link, server contract untouched and its suite green | S1, S7 | inline | `c2ca32a` |
| T8 | Stack context replaces the stored default in the tool path | S8, S9, S10, S11, S12 | worker `stackid-request-context` | `b34a578` |
| T9 | `MCP_DEFAULT_STACK_ID` optional in provisioning, with one deprecation warning | S8, D6 | inline | `a25bf44` |
| T10 | README:218 and :621 describe the variable as ignored, with the fail-closed consequence beside them | S13 | inline | `47abfce` |
| T11 | Independent read-only verification pass over unit 2 | S8-S12 | `gentle-ai-verify` | `result:verify-stack-context#1` (all twelve claims confirmed; findings F1-F3 raised) |
| T12 | `mcp-http-seam.test.ts` documents both sides of fail-closed: the permitted omitted-stackId call, and the no-context refusal that never reaches the upstream | S9, S10 | worker `stackid-request-context` | `b34a578` |
| T13 | Ingest-local error formatter so the upstream message survives to the screen | S14 | inline | `7de1a8e` |
| T14 | Scope gate: unknown/unreadable schema counts as Stack-scoped, with one test per shape and both branches | S15 | inline (RED first) | `9beddaf` |
| T15 | Postgres-gated proof that a turn's Stack survives into the background chain, two concurrent turns of one user | S12, D-E2E | inline | `e461b0d` |
| T16 | S11 restated (the header is never stored) and S15 recorded | S11, S15 | inline | `dbd9672` |
| T17 | A1 settled by reusing the maintained `STACK_TOOLS` constant, no host evidence needed | S16 | inline (RED first) | `03e6e9f` |
| T18 | `fallow` on the branch | D-GATE | **withdrawn by the peer: not this repo's gate** | — |
| T19 | A `stackId` nested under `properties` at any depth makes the tool scoped; scan bounded, cycle-guarded, cap means unknown | S15 (F1) | inline (RED first) | `744eb52` |
| T20 | A duplicated or joined `x-stack-id` yields NO context | S17 (F2) | inline (RED first) | `d6448dd` |
| T21 | A non-string `stackId` is refused as a type problem, with its own message | S18 (F3) | inline (RED first) | `744eb52` |
| T22 | The independent verification's two probes adapted into the repo (route boundary, App boundary) | S2-S5, S11, S12 | inline | `d6448dd`, `6adf0cf` |
| C1 | Reset the dev database volume and run the Postgres tier so the end-to-end proof EXECUTES | S12, D-E2E | inline | `840b3c9` |
| C2 | `scripts/ci.sh` plus a thin GitHub Actions wrapper, and the database gate asks a real query | D-GATE-CI | inline | `7da9c35` |
| C3 | README: one command, which tiers run and which one does not, and why | D-GATE-CI | inline | `3e05b06` |
| C4 | Compose network derived, cleanup without `-v`, and the differently-named-directory proof | S20 | inline | `0bf9b6b` |
| C5 | The task table reconciled for real, with a test that keeps it honest | S21 | inline | `eae902f` |
| C6 | Tenancy tests split from the model gate so CI exercises isolation | S22 | inline (RED reasoned, not decorative) | `8fb228a` |
| C7 | Concurrency, and the `-v` warning where the README advertises it | S23 | inline | `077ca64` |
| C8 | The pin guard asserts the EXPORT form on configuration, and no assertion reads prose | S20 | inline (mutation-proven) | `fa470dd` |
| C9 | The whole network name is derived from `docker compose config`, requiring exactly one network | S20 (NET-KEY) | inline | `fa470dd` |
| C10 | S21 restated to one document, plus the census sentinel | S21 | inline | `fa470dd` |
| C11 | The pending test that could not fail is gone | S21 | inline | `fa470dd` |

T2-T5 land as one work unit because the SPA must compile: the hook, the panel and the
App all read the same value, so no intermediate commit can remove one end alone.

## Delivery slices

Unit 1 is one reviewable slice: `490bef0` (frontend + tests) with `c2ca32a` (docs).
Measured after T5's deletion: web 166 tests pass, `tsc --noEmit` clean, production
build clean; server 174 tests, 132 pass, 0 fail, 42 skipped, `server/` untouched.

Unit 2 is its own slice: `b34a578` (request context replaces the stored default),
`a25bf44` (provisioning deprecation), `47abfce` (README). Measured: server `tsc`
clean, 188 tests, 146 pass, 0 fail, 42 skipped (Postgres-gated by design); web
typecheck clean, 172 tests.

Unit 3 is the smallest slice and closes the S6 residual: `7de1a8e`.

Unit 4 (the independent pass's findings) is four commits: `744eb52` (nested scan + type
error), `d6448dd` (ambiguous header), `6adf0cf` (App-boundary probe), `2ee77e5` (docs).
Measured: server 211 tests, 168 pass, 0 fail, 43 skipped; web 177.

Unit 5 is the proof and the gate, one commit each: `840b3c9` (the executed end-to-end
tier: 227 tests, 227 pass, 0 fail, 0 skipped, with `ok 154 - a turn's Stack survives into
the background chain, per request`), `7da9c35` (`scripts/ci.sh` plus the workflow wrapper,
executed here: exit 0, server 227 tests / 193 pass / 0 fail / 34 skipped for the
live-model tier, web 177 tests and a production build), `3e05b06` (README and this log).

## Log

L1 (requester's original request, verbatim):
"Se acaba de crear una feature que es multitenant-stackId, que simplemnte ya no es necesiria la variable env de StackId, asi que el Agente en su frontEnd no necesita implementarlo, asi que se gestionara via parameterUrl asi al ingestar como se requiere del StackId se sacara el StackId de ahi"

L2 (peer decisions, binding, verbatim where they constrain the implementation):
D1 — link parameter `stackId`, read once at mount, link is the only source.
D2 — API contract unchanged; server keeps `stackId` optional; `ingest-routes.ts` untouched.
D3 — shape check in the browser, then surface the server answer; no `list_stacks` pre-validation, no `defaultStackId()`, no retry loop.
D4 — reads follow the same rule: no list, no poll, no create without a valid link value.
D5 — this document's ID; record the supersede above; do not rewrite `pi-chat-mvp.md`.
D6 — `MCP_DEFAULT_STACK_ID`, `tenant_mcp.default_stack_id`, `README.md:218` and
`README.md:588` are provisioning-scoped and stay untouched.

L3 (audit before implementing, evidence): the frontend never had a StackId env var —
`web/src` has no `import.meta.env`/`VITE_*` and `web/Dockerfile` has no build args —
so S1's "no env var in the frontend" was already true. What contradicted S2/S3/S4 was
the picker: `<select>` in `IngestJobsPanel.tsx:72-99`, `selectedStackId` in
`use-ingest.ts:90`, and `defaultStackId()` in `stacks.ts:85` pre-selecting the Stack
the upstream marks `isCurrent`. The transport was already request-scoped
(`ingest-routes.ts:57`, `ingest/client.ts:111`), so no server change was needed.

L4 (unit 2, STOP reported and accepted): retiring `MCP_DEFAULT_STACK_ID` was refused
until the replacement existed. The MCP http transport carries no per-tenant credential
— its only headers are `HEADERS = { accept: "application/json, text/event-stream" }`
(`server/scripts/provision-mcp.mjs:129-133`) — so every tenant shares one URL and one
upstream process binding, and an omitted `stackId` covered that single shared Stack.
Removing the injection would have made every row behave like NULL. Evidence:
`conversation-store.ts:320,346,360`, `main.ts:92,105`, `tenant-runtime.ts:49,202,295,319-320`.

L5 (unit 2, design gate accepted): no persistence is needed. `AsyncLocalStorage`
carries the request's Stack from the turn route into the tool call, so the tenant
runtime can stay one-per-user and the schema stays untouched. The load-bearing
detail is `turn-service.ts:88`, where `execute` is launched synchronously inside
`start()` and therefore inherits the store for the whole background turn — pinned by
its own concurrency test (S12). Precedence becomes explicit instead of silent: a
conflicting model argument blocks the call (S10).

L6 (peer amendment to D2, approved): `mcp-http-seam.test.ts:332` cannot stay green
as-is, because its scenario is a Stack-scoped tool executed with no Stack — exactly
what the fail-closed rule now forbids. It is updated in unit 2 (never skipped, never
deleted) to keep its real intent — an omitted `stackId` is fine for the upstream
because the server fills it from the request context — and the same file gains the
companion asserting the opposite branch: no context ⇒ `isError`, and `callTool`
never invoked. `ingest-adapter.test.ts:481` stays untouched: that is the ingest API,
which keeps `stackId` optional.

L7 (unit 3 authorised, narrower than proposed): the `400` message finding is fixed
by an ingest-local formatter only. `errorFrom` is NOT modified — it is shared with
chat and every other call, so changing its copy would be precisely the unrequested
shared-behaviour change the rules forbid. The R4 pin moves from `/400/` to the
upstream message in that unit.

L8 (peer decisions after B1, binding): D-B1 = unknown schema counts as Stack-scoped,
chosen for PARITY with the baseline, which injected into every call; the two todo pins
are promoted, one test per shape, both branches, no todo markers left. D-A1 =
`list_stacks` is Stack-scoped and no name list will ever be used, gated on real
evidence. D-A2 = S11 restated. D-A3 = accepted, noted. D-E2E = the end-to-end gap gets
a Postgres-gated test, not a note. D-GATE = run the project's pre-commit checks,
`fallow` included. D-EVIDENCE = exactly one read-only `tools/list`, and if the host is
unreachable, say so and stop.

L9 (unit 2 closure evidence): `9beddaf` replaced the gate — 8 RED tests observed
(four shapes × both branches), then 28/28 green across the gate, context and injection
suites. `e461b0d` added the background-chain proof. Suite with the dev database down:
server 203 tests, 160 pass, 0 fail, 43 skipped (42 pre-existing plus this one), web
172 pass, `tsc` clean in both.

L10 (two gates that could not run, reported rather than improvised):
- **D-EVIDENCE blocked.** No reachable MCP host from this machine: `172.17.0.1:4173`,
  `172.17.0.1:4240`, `host.docker.internal:4240`, `127.0.0.1:4173`, `127.0.0.1:4240`
  and the configured ingest host `192.168.32.1:4240` (on `/`, `/mcp`, `/api/stacks`)
  all failed to connect, and no `MCP_SERVER_URL` is configured anywhere here. No
  `tools/list`, no name list invented, A1 stays open.
- **D-GATE blocked** (withdrawn later — see L12; this line records what happened at the
  time, not a live blocker). `fallow` is not a dependency of this repository, has no
  `.fallowrc.json`, and is not installed globally; the only matches on this machine are
  scratch copies belonging to another project. Installing it would be a dependency
  change needing approval. The checks this repo actually declares — `tsc --noEmit`,
  `npm test`, `npm run build` in `server/` and `web/` — ran and are reported.

L11 (environment finding, from trying to execute the e2e tier): bringing the compose
database up is not enough. The existing `agentdoc-pgdata` volume was initialised with a
password this checkout does not have — the trap the README documents at line 129 — so
host connections fail with `password authentication failed`. `support/harness.ts`
gates on CONTAINER HEALTH only, so with the container healthy the previously skipped
tier ran and failed: 19 failures and 19 cancellations, none of them stack tests. The
container was stopped again to leave the machine as it was found. **Resolved by L18**: the
volume was reset under the requester's written authorisation, and the tier executed.

L12 (peer retraction): **D-GATE withdrawn.** `fallow` is a Pre-Commit Check of the
`llm-wiki-compiler` agent instructions, not of this repository, so it was never this
branch's gate. Nothing installed, no dependency added, `package.json` untouched.

L13 (A1 closed without host evidence, by reuse). The gate gains clause (c): the name is
in `STACK_TOOLS`, the constant this repo already maintains to GRANT those tools
(`server/scripts/provision-mcp.mjs:127`). That answers the T12 objection: it is not a
fresh list describing another service's contract, it is the list that already exists
here. The import direction is `src` → `scripts`, which works at runtime because
`server/Dockerfile:21` copies `./scripts` into the image and `provision-mcp.mjs` is
import-safe (its `main()` only runs when invoked directly). One definition, so a tool
added to provisioning is Stack-scoped for the agent in the same edit.

L14 (D-E2E, answered plainly): **this repository has no CI configuration at all** — no
`.github/`, no GitLab/CircleCI/Jenkins file, no Makefile, and `git log -- .github` is
empty. So the Postgres-gated tier does not execute in CI; it executes only on a machine
that can authenticate to a dev database, and this checkout cannot. By the standard set
for it — a test that never runs is documentation, not proof — **the end-to-end
inheritance of the request context into the background turn remains UNPROVEN.** It is
pinned by `server/test/stack-turn-context.test.ts` and still needs a database.
**SUPERSEDED by L18**: with a database this checkout can authenticate against, that test
executed and passed, and the CI script keeps it executing.

L15 (residual, not fixed here): `server/test/support/harness.ts:22-33` decides whether
the database tier can run from CONTAINER HEALTH alone. A volume initialised with a
different password therefore turns 42 skips into 19 failures and 19 cancellations
instead of a clean skip. Fixing it is a test-infrastructure change outside this feature;
it is recorded because it cost a red suite to discover.

L16 (peer's four fixes after the independent pass, all landed):
- **F1, a real divergence.** The gate read top-level `properties` only, so a `stackId`
  nested inside a filter object was judged unscoped: no refusal without a context and no
  injection with one. The spec said nested is unknown ⇒ scoped, and the spec was right;
  the code now scans the tree with a depth cap and a visited guard, where hitting the cap
  is UNKNOWN rather than "none".
- **F2, duplicate header.** Node joins two `x-stack-id` lines into `"first, second"`, so
  the array branch was unreachable through the real server and the joined string became
  the Stack. Both shapes now yield no context.
- **F3, non-string `stackId`.** A number or boolean was reported as a conflict with
  `String(named)` — a sentence about a Stack that cannot exist. It is now a type error
  with its own message, and the conflict branch is reserved for two real strings.
- **F4, this document.** T11/T16/T17 now match their commits instead of contradicting
  them. A tracked document that disagrees with its own history is worse than none.

Accepted without a code change: the header travels on every request to our own server
(S19). Reported, not fixed: the same duplicate-header shape at `routes.ts:145` and
`auth.ts:82-85`.

L17 (probes kept, adapted): the verification pass left two unusable-as-is probes; both
now live in the repository testing the boundary rather than the seam —
`server/test/stack-route-context.test.ts` (real router over a real socket: trim, blank
and absent mean no context, nothing inherited between requests, concurrency, and the
duplicate header refused) and `web/src/app-zero-requests.test.tsx` (App-level: four
shapes of a link without a Stack issue zero requests and show the alert, and a link with
one carries it everywhere). The duplicate-header case asserts the NEW expectation.

L18 (C1, the proof we never had — requester's authorisation, verbatim):

> "1 creemos un CI basico con docker que pruebe los tests 2 puedes eleminar todo es data de prueba"

Deletion scope, exactly two targets and nothing else: the local dev volume
`agentdocumentor_agentdoc-pgdata` (recreated by `docker-compose.yml` with the credentials
that file declares) and the verification scratch `/tmp/verify-mts.MMOB6G`. The
`agentdoc-workspace` volume was NOT touched, no image, network, remote host or other file
was touched, and `docker compose down -v` was deliberately not used because it would have
removed both volumes.

Result of the run that follows a fresh `initdb`:

    ok 154 - a turn's Stack survives into the background chain, per request
    # tests 227
    # pass 227
    # fail 0
    # skipped 0

**The end-to-end inheritance of the request context is now proven, not asserted.** With a
database this checkout can authenticate against, every tier ran — including the
credential-gated live-model tests, because this machine has real Pi credentials — and all
227 passed. The 19 failures and 19 cancellations seen earlier were the volume's password
and nothing else, which is now measured rather than assumed.

Consequence for the next task: the password the tests use is `agentdocumentor`, the
compose file's default (`docker-compose.yml:12`), and it is in the repository — so CI
needs no secret for the database, and no password has to be hardcoded outside the file
that already declares it.

L19 (C2, CI that cannot be fiction): the gate is `scripts/ci.sh`, one executable file a
person runs with `bash scripts/ci.sh`; `.github/workflows/ci.yml` only checks out and
calls it, so no command exists in YAML that is not in the script. GitHub Actions was the
choice because `git remote -v` is `https://github.com/urgosxd/harnes-wiki.git`.
The script builds the production images (`docker compose build`) and the `test` targets
of both Dockerfiles (the runtime images omit dev dependencies on purpose), starts the
compose database, waits for a real `select 1`, then runs `tsc --noEmit` and `npm test`
inside the server test image with `CI_REQUIRE_DATABASE=1`, and the web typecheck, suite
and `vite build`. Any failure exits non-zero; there is no `continue-on-error`.

Executed here, not described: the whole script passed, the server suite reported 227
tests with 193 passing and 34 skipped (the live-model tier, skipped because the script
points `PI_AGENT_DIR` at a missing path), 0 failures — and
`server/test/stack-turn-context.test.ts` executed inside the CI-shaped container and
passed on its own:

    ok 1 - a turn's Stack survives into the background chain, per request

The `.dockerignore` keeps `test/` out of every image on purpose, so the suite is mounted
read-only from the working tree instead of being baked in: the tests that run are always
the checked-out ones, and the credential-baking risk the ignore file documents stays
closed.

Harness trap closed in the same unit (`server/test/support/harness.ts`): the tier is no
longer gated on container health, which answers a different question than "can I
connect". It asks a real query now, and with `CI_REQUIRE_DATABASE=1` an unreachable
database fails the build instead of quietly dropping a tier from the run.

No secret was invented: the database password is `docker-compose.yml:12`'s default and is
in the repository, so CI needs nothing stored. The Pi-credential tier is the one that is
NOT covered in CI, and the README says so in a table rather than in a footnote.

L20 (B1, found by the independent pass over the CI commit, and it was a real one): the gate
pinned a Docker network named after THIS checkout. Docker derives the compose project from
the directory holding `docker-compose.yml` — `AgentDocumentor` here, the repository's name
under `actions/checkout` — so in the CI it was written for, the project would have been
`harnes-wiki` and the network `harnes-wiki_internal`, and `docker run --network
agentdocumentor_internal` would have failed on every push, with the failure reported as
"no database answered a query". Measured from a scratch directory named `harnes-wiki`:

    without the pin:  name: harnes-wiki
    with the pin:     name: agentdocumentor

That is the worst shape a gate can have: it does not pass when the code is broken, it fails
when the code is fine, and it names the wrong cause. Fixed by pinning
`COMPOSE_PROJECT_NAME` in the script (so the project, its containers and its network are
identical on a laptop and in CI), by keeping and printing the last database error instead
of discarding it, by running `push` on `main` only so a branch PR does not run twice, and by
bounding the job with `timeout-minutes`. Two contract tests keep it fixed:
`server/test/ci-gate-contract.test.ts` (the workflow runs the script and nothing else, no
checkout-derived Docker name, the tier is required and the suite mounted, neither image has
its test stage as the default) and `server/test/db-gate.test.ts` (both directions of
`CI_REQUIRE_DATABASE`, including that the failure never echoes the password).

Accepted without a fix, as advisories: under the flag an unreachable database throws at
import in six files, so the run reports less than a skip list would; the script rebuilds
four images and leaves the database running on every invocation, which is what its own
output says.

L21 (the audit's blockers, and the false green). Two blockers, both cases of an artefact
contradicting its own commits, plus one false-green vector that mattered more than either.

- **B2, path dependence.** The gate named a network derived from the checkout directory. It
  was pinned first and then DERIVED from `docker compose config`, and the proof the audit
  asked for exists: `bash scripts/ci.sh` run from a copy of the repository at
  `/tmp/ci-proof/harnes-wiki` — a different directory name — exited **0**, server 233 tests,
  195 pass, 0 fail, 38 skipped, web suite and build green. A path-independent gate that has
  only ever run at one path was not proven; now it has run at two.
- **B1, the document lied twice.** T19/T20/T21/T22 and C3 named their commits and still read
  `pending`, and the header said `in progress` with nothing pending. `eae902f` fixes the
  rows and the status, and `server/test/feature-doc.test.ts` now asserts the two rules over
  every five-column task table — reading only that table shape, because the first draft
  misread four legacy documents and failed on their column counts.
- **The false green.** `http-api.test.ts` and `isolation.test.ts` gated every assertion on
  database AND credentials, so CI skipped about eighteen tests including the tenancy
  isolation ones. That is the property the whole feature exists to protect. The gates are
  split now: in the CI shape (database present, no credentials) **eleven of those nineteen
  tests run and pass** where all nineteen used to skip, and only the eight that drive a real
  turn skip, each saying "needs a reachable Postgres and Pi credentials".
  The gate run after the split: **244 tests, 220 pass, 0 fail, 24 skipped** — ten more
  executed than before it, and the four contract tests and five feature-doc tests now run
  in the container too, because `CI_REPO_ROOT` points them at a read-only mount of the
  checkout instead of skipping for lack of one.

Accepted, not fixed: the audit's certification of the requester's quote (verbatim, including
the missing accent in "eleminar") closes that claim from the peer's side; the comma
narrowing in `x-stack-id` is documented rather than softened, because a Stack id containing
a comma is not a real case and the rule is fail-closed; and no lint tier exists in this
repository, so none was added.

L22 (the audit's five, and the mutation habit paying off). Each was a guard that measured
the wrong thing, which is now the dominant failure mode of this feature's tests — five
instances, every one of them green.
- **FG-PIN**: deleting `export COMPOSE_PROJECT_NAME` reinstated the checkout-derived naming
  (the original blocker) while both assertions stayed green: one matched a bare string, the
  other matched a comment. The guard now requires the EXPORT form, in configuration.
  Proven: deleting the line fails it.
- **FR-RAW**: the same assertion read raw text, so a comment documenting the historical
  failure would have failed the guard and taught the next person to delete the
  documentation. Proven: adding that comment now passes.
- **NET-KEY**: the script appended a hardcoded `_internal` to the project name, so renaming
  the compose network key would have pointed at a network compose never creates — B2 again,
  with B2's misleading timeout. The whole name now comes from `docker compose config`, one
  network required, failure loud. Proven: `agentdocumentor_internal` by default,
  `demo_internal` with the project overridden.
- **S21-REACH**: the spec overstated its reach (five documents), and one comment described a
  four-column-with-commit table that does not exist anywhere in the corpus. Both corrected,
  and a census sentinel now fails if a task-shaped table is skipped or a second document
  starts carrying task rows.
- **DEAD-ASSERT**: one pending test could not fail while the bi-directional one passed, so
  it was deleted rather than kept as decoration; both mutations remain caught.

L23 (requester's behaviour definition, binding). Verbatim: "el comportamieno es que tu
como cliente, con la tool list_stacks tengas la lista de stacks, pero por default tu
tendras un StackId via urlParameter"
- (a) `list_stacks` enumeration is intended: it is how a client discovers the available
  Stacks, not a disclosure defect. Measured ordinary calls return a multi-entry page with
  exactly one entry flagged `isCurrent`.
- (b) The default selection comes from the URL parameter — the `stackId` in the link. A
  Stack is a selection, never an authorisation (S11).
- (c) Surfaces must not be conflated, and on THIS branch the split is: the MCP tool
  `list_stacks` is MCP-surface, consumed by an MCP client. `listStackIds()` in
  `server/src/ingest/client.ts` issues a REST `GET /stacks` against `INGEST_API_BASE_URL`
  and is called server-side only, from the pre-create existence check in
  `server/src/api/ingest-routes.ts`. There is NO browser picker and no `/stacks` read in
  `web/src` at this HEAD: `T15` superseded the picker, and `web/src/lib/stacks.ts` was
  last touched by the commit that removed it (`490bef0`). Any selector fed by a Stack
  listing lives on `feat/urlparam-stackId`, not here.
- (d) These host facts describe `127.0.0.1:4577/mcp` at build
  `6b83fbad88169caf5a6b4e8c173c193465c849c8`, `llmwiki 1.4.0-dev.20260919`, and nothing
  else: multi-entry page, `count` 50 equals page size, 200 at `limit: 200`, no
  `total`/`cursor`/`offset`/`hasMore`, exactly one `isCurrent`, other Stacks present in
  ordinary calls; all 14 tools declare `stackId`, 13 list it in `inputSchema.required`,
  `list_stacks` has no `required` array and its `stackId` description states it does not
  narrow the listing.
