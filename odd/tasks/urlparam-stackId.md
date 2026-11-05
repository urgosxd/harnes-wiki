# feat/urlparam-stackId — the URL's stackId as default, an explicit choice as override

Scope: the stackId resolution order for tool calls, and the ingest form's stackId prefill plus selection.
Branch: feat/urlparam-stackId.

## Specs

S1. Tool calls use the stackId in the URL by default, and an explicitly indicated one wins over it:
"cuando se llamen la tools se debera usar por default o fallback el parameter URL ahi esta el stackId, si el usuario inidaca que se use otro se usara, pero como fallback simpero el de la url"

S2. Ingest prefills the same URL-derived stackId as its fallback:
"Ademas de tambien llenar por default en ingest ,como fallback , el mismo caso"

S3. Ingest lets the user choose the stackId it submits:
"y que tambien se pueda elegir el stackId para hacer ingest"

S4. When the stackId is resolvable from neither source, the surface says so instead of using an empty or undefined stackId:
"if the stackId cannot be resolved from either source, surface a clear error rather than silently using an empty/undefined stackId"

## Tasks

| ID | Task | Spec | Route | Commit |
| --- | --- | --- | --- | --- |
| T1 | Explicit tool argument wins over the turn's URL-derived stackId; the URL stays the only fallback; a clear error when neither exists | S1, S4 | worker | 1b1514e |
| T2 | Read-only `GET /stacks` exposing the known stack ids | S3 | worker | 0b05b18 |
| T3 | `listStackIds` client method and useIngest effective stackId (selection wins, URL is fallback, notice when neither) | S2, S3, S4 | worker | pending |
| T4 | Ingest stackId selector preselected from the URL, submitting the chosen value | S3, S4 | worker | pending |
| T5 | Docs and help copy for the new order and the selection | S1-S4 | worker | pending |

## Log

L1 (user, verbatim):
"Procjet 2: feat/urlparam-stackId
cuando se llamen la tools se debera usar por default o fallback el parameter URL ahi esta el stackId, si el usuario inidaca que se use otro se usara, pero como fallback simpero el de la url, Ademas de tambien llenar por default en ingest ,como fallback , el mismo caso y que tambien se pueda elegir el stackId para hacer ingest"

L2 (Manager, derived scope, verbatim):
1. Resolution order for stackId in tool calls must be: explicit user-supplied stackId (tool argument) if provided, otherwise fall back to the stackId present in the current URL/page context. The URL value is always the fallback.
2. Ingest must prefill the stackId field by default with the same URL-derived value (fallback behavior identical to tool calls).
3. The user must be able to choose a different stackId for ingest (a selectable control listing available stackIds, with the URL-derived one preselected), and ingest must submit the chosen one.
Also: if the stackId cannot be resolved from either source, surface a clear error rather than silently using an empty/undefined stackId.

L3 (Lead, reconnaissance evidence):
- URL to tool calls today: `web/src/lib/tenant.ts:47 parseStackId` → `web/src/App.tsx:32-34` → `x-stack-id` header (`web/src/App.tsx:104`) → `server/src/api/routes.ts:147 withStackContext` → `server/src/pi/tenant-runtime.ts:335 resolveStackArgument`.
- S1 gap: `server/src/pi/tenant-runtime.ts:363-371` errors instead of honoring a differing explicit `stackId` tool argument.
- S2/S3 gap: `web/src/lib/use-ingest.ts:198-200` spreads the URL-valued `stackId` after the caller's options, discarding any selection; `web/src/lib/api.ts:201,255` already send `stackId` in the ingest body.
- No stack list reaches the UI: `server/src/api/ingest-routes.ts:224` uses `c.listStackIds()` internally only.
- Ingest contract already accepts an optional body `stackId` and rejects unknown ids with `400 unknown_stack` (`server/src/api/ingest-routes.ts:102-105,223-234`).

L4 (Lead, decision): S1 supersedes the conflict-error rule of `odd/tasks/multitenant-stackId.md` (S10). The URL remains the only fallback, never a remembered or defaulted value. Confirmed by the Manager in L5 (decision D1): T1 stands as implemented and is not reverted.

L5 (Manager, decision D1, verbatim): "D1 APPROVED as you stated it. Your reading matches the human's verbatim requirement ("si el usuario indica que se use otro se usará, pero como fallback siempre el de la URL"), so the explicit tool argument wins and the URL-derived stack is the only fallback. Do not drop T1." Binding conditions: T1 keeps its own commit and an independent verification by an Agent that did not implement it; S10 is superseded append-only so its original text stays legible; the override is non-silent on the server through one structured log line naming the turn's URL-derived stack and the argument's stack, with no new UI; failure modes stay as today (unknown Stack still `400 unknown_stack`; when neither source resolves a stack, a clear error and no silent empty value); the ingest request body contract is unchanged and `GET /stacks` stays purely additive and read-only.
