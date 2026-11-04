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

S11 (transport). `x-stack-id` is forwarded by this product's own SPA to this product's own server, shape-validated (trimmed; empty ⇒ no context), never persisted, never stored with the conversation, never logged with content. It is a SELECTION, never an authorisation: the server derives no entitlement from it, and under `AUTH_MODE=open` any caller can set it — the same caller can already claim any `x-user-id`.

S12 (concurrency, named risk). Two turns started concurrently with different Stack contexts must each see their own value on every tool call, with no bleed, because the tenant runtime is shared per user (`server/src/main.ts:87,110-116`).

S13 (scope guard). No hard gate on the chat surface in this unit: without a `stackId` in the link, Stack-scoped agent tools fail closed and the error text names the missing Stack, and the README states that consequence next to the deprecated variable line.

## Tasks

| ID | Task | Spec | Route | Commit |
|---|---|---|---|---|
| T1 | Feature document and the supersede record | S1 / D5 | inline | `docs(odd)` |
| T2 | Link parsing module (`web/src/lib/tenant.ts`) with its unit tests | S5, S2, S3 | inline | `feat(web)` |
| T3 | Ingest hook resolves the StackId from the link and issues zero requests while blocked | S2, S3, S4, S6 | inline | `feat(web)` |
| T4 | Panel loses the picker; the blocked state is the only thing it renders | S2, S3, S4 | inline | `feat(web)` |
| T5 | Dead picker machinery removed (`stacks.ts` and its tests) | S2 | inline | `feat(web)` |
| T6 | Public-surface tests for the four rules the requester named | S3, S4, S6 | inline | `test(web)` |
| T7 | README describes the link, server contract untouched and its suite green | S1, S7 | inline | `docs` |

T2-T5 land as one work unit because the SPA must compile: the hook, the panel and the
App all read the same value, so no intermediate commit can remove one end alone.

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
