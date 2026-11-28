# Feature: ingest-retract

Marcar los documentos ya ingeridos y hacer que Remove retire el contenido via compilacion.

## Specs

S1 — Check en los documentos ingeridos. User said: "quisiera un check en los items ya ingestados".
S2 — Saber que hace Remove hoy. User said: "y quiero saber que hacer remove".
S3 — Remove dispara una compilacion que borra. User said: "me gustaria que dispare una compilacion que haga delete".
S4 — Contrato de backend. User said: "dime que requieres del backend , que enpoints".
S5 — La marca es vigente por contenido: si el archivo cambia, la marca se cae sola. (Decision humana, L2.)
S6 — Remove no decide nada del lado nuestro: el panel solo llama a retract y llm-wiki posee la semantica. Sin gating por `current` en cliente ni en handler. (Decision humana, L2.)
S7 — Retraccion reversible: re-ingerir el mismo contenido restaura `source_hash` y marca. Sin tombstone permanente. (Decision humana, L2.)
S8 — Un documento, N estados de ingesta, uno por stack. (Decision humana, L2.)

## Contract

- `GET /api/documents` carries `contentHash` and `ingest { jobId, requestedAt, ingestedAt, current, known }`; the stack comes from the `x-stack-id` header, not a query parameter.
- `current` = the document's `content_hash` matches a `source_hash` in the wiki's `GET /stacks/:stackId/documents`. `known:false` when the wiki cannot be read; the UI must render "no data", never "not ingested".
- `POST /api/documents/:id/retract` -> 202 `{ jobId }`, 404 `document_not_found`, 409 `document_not_ingested` (no `document_ingests` row for that document+stack), 409 `busy`, 503 `source_retraction_unavailable` while E7 is not deployed. It never inspects `current`.
- Upstream `404 source_not_found` maps to our `409 document_not_ingested`: one client-visible code for "there was nothing to retract".
- `DELETE /api/documents/:id` -> 409 `document_ingested` when a `document_ingests` row exists with `last_status <> 'retracted'`; local state only, no external call.
- Upstream contract (E7): `DELETE /stacks/:stackId/sources/:identity`, identity = `storage_path` of the wiki row, deletion + compile atomic in one call, 202 `{ deleted, jobId }`, 404 `source_not_found`, stackId no default.

## Tasks

- S0 — feature document. Route: worker.
- S1 — migration 007: `documents.content_hash`, `document_ingests.stack_id`, composite PK. Route: worker.
- S2 — wire `recordIngest`. Route: worker. Commit `cff8f25`.
- S3 — `GET /api/documents` contract with `current`. Route: worker. Commit `4a5dfc4`.
- S4 — UI mark, three states. Route: worker.
- S5 — `POST /:id/retract` (503 while E7 pending). Route: worker.
- S6 — `DELETE` 409 guard. Route: worker. Commit `5aebe6b`.

## Open risks

- **Wiki envelope assumed, not recorded; closed in S5 against the real listing.** The
  `GET /stacks/:stackId/documents` body used by S3's fixture
  (`server/test/documents-ingest-state.test.ts`) is derived from the same service's
  `{ jobs: [...] }` collection convention, not observed: the wiki was not running when S3
  landed, and its contract document
  (`/home/urgosxd/Desktop/ofk/llm-wiki-compiler/docs/guides/http-ingest-jobs.mdx`) is
  outside this project root and needs the human's grant to read. The reader is tolerant
  (bare array; `documents`/`sources`/`items`/`data`; snake or camel fields) and an
  unrecognised envelope fails closed to `known: false` with no `current` key, so a wrong
  guess shows as "no data" and never as "not ingested". One read of that document settles
  it; the fix would be the fixture plus `readWikiRows` in
  `server/src/api/document-ingest-state.ts`.

## Log

L5 (worker): S6 landed in `5aebe6b` (`feat(api): refuse deleting an ingested document`) —
`server/src/api/document-routes.ts`, `server/src/db/document-store.ts`,
`server/test/documents-delete-guard.test.ts`. What the guard is, and the two decisions that
make it survive its own edge cases:
  1. `DELETE /documents/:id` refuses with `409 document_ingested` when ANY row in
     `document_ingests` for the document has `last_status <> 'retracted'`, REGARDLESS of
     `stack_id`. Scoping it to the request's `x-stack-id` would make "omit the header" (or
     naming an unrelated Stack) the way to delete a document another Stack still compiles,
     and the delete would cascade that live state with no retraction behind it. The query is
     `DocumentStore.hasActiveIngest(documentId)` — in the store, not inlined in the route,
     matching how `ingestFor` is placed.
  2. Ownership is checked FIRST (`findOwned`), then the guard, then the `DELETE`. A guard
     that answered first would return `409` for somebody else's document, confirming both
     that it exists and that it was ingested; a foreign document keeps the byte-identical
     `404 { error: "not_found", message: "no such document" }` it answers today. The final
     `DELETE` re-asserts ownership because it is the statement that actually decides.
  3. Local state only: the route never touches the wiki (the test registers a counting
     `DocumentIngestState` and asserts zero calls on every delete), and the message names
     the retraction endpoint rather than performing one — `POST /:id/retract` is S5.
  4. `retracted` is the only unblocking status, which is the S7 half: a retracted row
     describes content the wiki no longer holds, and a re-ingest resets the row, so
     everything-retracted deletes normally with its cascade.
  Evidence: `server/test/documents-delete-guard.test.ts` 7/7 (RED first: 4 of 7 failing
  against `bbe8593` — the three live-state `409` cases and the mixed retracted/requested
  one; the three preserve cases — all-retracted delete, no-rows delete, foreign `404` —
  passed before the change and still do), `cd server && npm test` 541/541,
  `npx tsc --noEmit` clean. Proven by execution: the guard, its non-Stack scope, the
  ownership ordering, the cascade on success, and the absence of an upstream call. Read
  from code, not executed: nothing about this path depends on the wiki envelope left open
  in `## Open risks` — the guard answers from our own rows.
  `server/test/documents.test.ts` stayed green unchanged, so no contract conflict: its
  delete case removes a document with no ingest rows, which is the split the guard needs.

L4 (worker): S3 landed — `content_hash` is written at upload and the listing answers the
ingest state. What changed and why:
  1. `POST /documents` hashes the stored bytes with `node:crypto` (`sha256`, plain lowercase
     hex, no prefix) and passes it into `DocumentStore.create`, so the column is written by
     the same statement as the bytes; a later `UPDATE` would leave rows with no identity and
     a second place deciding what the hash is. `DocumentRecord` gained `contentHash`, and
     every read that builds one now selects it.
  2. `IngestClient.listStackDocuments(stackId)` reads `/stacks/<id>/documents` — the Stack is a
     PATH segment there, unlike the job API's `?stackId=`, because one base URL serves both
     resource families.
  3. `server/src/api/document-ingest-state.ts` (new) holds the ONE comparison,
     `matchingWikiSource`, plus a 5 s per-Stack cache of the wiki listing and `readWikiRows`.
     `GET /documents` answers `contentHash` and `ingest { jobId, requestedAt, ingestedAt,
     current, known }`, `ingest: null` with no Stack or no `document_ingests` row, and
     `known: false` with NO `current` key when the wiki cannot be read (an unreadable answer is
     never cached, so a failure cannot be inherited as a stale success).
  4. `server/src/main.ts` passes the ingest client into `registerDocumentRoutes` only when a
     service is configured; otherwise every document answers `ingest: null` and nothing is
     called upstream.
  OPEN RISK, named in `## Open risks`: the wiki envelope in the test fixture is ASSUMED, not
  recorded (the service was not running, and its contract document is outside this project
  root). Fail-closed is proven by two unrecognised-envelope cases, and closing this is one
  read in S5.
  Evidence: `server/test/documents-ingest-state.test.ts` 11/11 (RED first: 9 of 10 failing
  against `8a85763`, the module absent; the unrecognised-envelope case was mutation-checked by
  adding `rows` to `COLLECTION_KEYS`, which failed it alone, then reverted),
  `cd server && npm test` 534/534, `npx tsc --noEmit` clean. Proven by execution: the whole
  listing contract, the cache window, the fail-closed paths and the hash of a known vector.
  Read from code, not executed: the production wiring in `main.ts`.

L1 (user, verbatim): "en la ui de ingest , hay botones en cada recurso para ingent hay ingest y remove ademas quisiera un check en los items ya ingestados, y quiero saber que hacer remove me gustaria que dispare una compilacion que haga delete, asi que dime que requieres del backend , que enpoints"

L2 (human, relayed by the Chief): (a) marking = ingested and current by hash, a changed file drops the mark by itself; (b) Remove decides nothing on our side, the panel only calls the retraction endpoint and llm-wiki owns the rest, no conditional branch on `current` in the client or the handler; (c) reversible: re-ingesting the same file restores the content, no permanent tombstone; (d) data model 1:N, one document with one ingest state per stack.

L3 (worker): S2 landed in `cff8f25` (`feat(api): record document ingests per stack`) — `server/src/db/document-store.ts`, `server/src/api/ingest-routes.ts`, `server/src/main.ts`, `server/test/document-ingest-record.test.ts`. Three defects/incomplete facts fixed, not just wired:
  1. `recordIngest` upserted `ON CONFLICT (document_id)`, a unique constraint migration 007 removed when it made the key `(document_id, stack_id)`. Postgres raises on a conflict target with no matching constraint, so the write would have failed on its first call, exactly as it failed silently before it had callers. It now names the composite key and RESETS `last_status` on re-ingest (the data half of S7, no tombstone).
  2. `ingestFor` filtered on `document_id + user_id` and returned `rows[0]`, which with N stacks answered with another Stack's job id. It now requires the stack and filters on it.
  3. The route records only after the upstream answers 2xx WITH a job id, and never for a source-kind job or a job that names no Stack. `server/src/main.ts` gained the one line that gives the seam its production call site (`ingests: documents`), approved by the Lead: the previous `recordIngest` had no callers and nobody noticed.
  Evidence: `server/test/document-ingest-record.test.ts` 10/10 (RED first: 6 of 8 failing), `cd server && npm test` 523/523 passing, `npx tsc --noEmit` clean. The store and route behaviour is proven by execution; the production wiring in `main.ts` is read from code, not executed by any test.
  Open for S3: `requested_at` keeps the FIRST request on re-ingest (documented in the store), and a document ingest with no named Stack writes no row.
