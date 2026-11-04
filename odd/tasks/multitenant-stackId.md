# Feature: multitenant-stackId

The tenant StackId stops being deployment configuration and becomes request-scoped
context carried by the link. The ingest surface resolves it from the URL at mount and
names it on every read and write; the Stack picker and its silent default are gone.

Status: in progress
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

S15 (B1, the scope gate — binding, and the reason it is not a heuristic). A tool is Stack-scoped **iff** its published schema is unreadable or of unknown shape, OR it is a readable flat object whose `properties` include `stackId`. It is NOT Stack-scoped **only** when the schema is a readable flat object with `properties` present that does not include `stackId`. Absent `properties`, `additionalProperties: true`, `allOf`/`anyOf`/`oneOf`/`$ref`, and anything nested or composed are all UNKNOWN ⇒ scoped. The argument for unknown-is-scoped is PARITY: the baseline injected a Stack into every call without reading the schema, so this rule can only narrow the read scope relative to that baseline, never widen it.

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
| T11 | Independent read-only verification pass over unit 2 | S8-S12 | `gentle-ai-verify` | in flight |
| T12 | `mcp-http-seam.test.ts` documents both sides of fail-closed: the permitted omitted-stackId call, and the no-context refusal that never reaches the upstream | S9, S10 | worker `stackid-request-context` | `b34a578` |
| T13 | Ingest-local error formatter so the upstream message survives to the screen | S14 | inline | `7de1a8e` |
| T14 | Scope gate: unknown/unreadable schema counts as Stack-scoped, with one test per shape and both branches | S15 | inline (RED first) | `9beddaf` |
| T15 | Postgres-gated proof that a turn's Stack survives into the background chain, two concurrent turns of one user | S12, D-E2E | inline | `e461b0d` |
| T16 | S11 restated (the header is never stored) and S15 recorded | S11, S15 | inline | pending |
| T17 | One read-only `tools/list` against the real host, to settle A1 on facts | D-EVIDENCE | **blocked: host unreachable** | — |
| T18 | `fallow` on the branch | D-GATE | **blocked: not a dependency here** | — |

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
- **D-GATE blocked.** `fallow` is not a dependency of this repository, has no
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
container was stopped again to leave the machine as it was found. A1's evidence and the
e2e test both need a database this checkout can authenticate against, or the volume's
password.
