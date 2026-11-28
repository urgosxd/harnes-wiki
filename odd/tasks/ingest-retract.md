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
- S3 — `GET /api/documents` contract with `current`. Route: worker.
- S4 — UI mark, three states. Route: worker.
- S5 — `POST /:id/retract` (503 while E7 pending). Route: worker.
- S6 — `DELETE` 409 guard. Route: worker.

## Log

L1 (user, verbatim): "en la ui de ingest , hay botones en cada recurso para ingent hay ingest y remove ademas quisiera un check en los items ya ingestados, y quiero saber que hacer remove me gustaria que dispare una compilacion que haga delete, asi que dime que requieres del backend , que enpoints"

L2 (human, relayed by the Chief): (a) marking = ingested and current by hash, a changed file drops the mark by itself; (b) Remove decides nothing on our side, the panel only calls the retraction endpoint and llm-wiki owns the rest, no conditional branch on `current` in the client or the handler; (c) reversible: re-ingesting the same file restores the content, no permanent tombstone; (d) data model 1:N, one document with one ingest state per stack.

L3 (worker): S2 landed in `cff8f25` (`feat(api): record document ingests per stack`) — `server/src/db/document-store.ts`, `server/src/api/ingest-routes.ts`, `server/src/main.ts`, `server/test/document-ingest-record.test.ts`. Three defects/incomplete facts fixed, not just wired:
  1. `recordIngest` upserted `ON CONFLICT (document_id)`, a unique constraint migration 007 removed when it made the key `(document_id, stack_id)`. Postgres raises on a conflict target with no matching constraint, so the write would have failed on its first call, exactly as it failed silently before it had callers. It now names the composite key and RESETS `last_status` on re-ingest (the data half of S7, no tombstone).
  2. `ingestFor` filtered on `document_id + user_id` and returned `rows[0]`, which with N stacks answered with another Stack's job id. It now requires the stack and filters on it.
  3. The route records only after the upstream answers 2xx WITH a job id, and never for a source-kind job or a job that names no Stack. `server/src/main.ts` gained the one line that gives the seam its production call site (`ingests: documents`), approved by the Lead: the previous `recordIngest` had no callers and nobody noticed.
  Evidence: `server/test/document-ingest-record.test.ts` 10/10 (RED first: 6 of 8 failing), `cd server && npm test` 523/523 passing, `npx tsc --noEmit` clean. The store and route behaviour is proven by execution; the production wiring in `main.ts` is read from code, not executed by any test.
  Open for S3: `requested_at` keeps the FIRST request on re-ingest (documented in the store), and a document ingest with no named Stack writes no row.
