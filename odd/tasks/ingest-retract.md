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
- S2 — wire `recordIngest`. Route: worker.
- S3 — `GET /api/documents` contract with `current`. Route: worker.
- S4 — UI mark, three states. Route: worker.
- S5 — `POST /:id/retract` (503 while E7 pending). Route: worker.
- S6 — `DELETE` 409 guard. Route: worker.

## Log

L1 (user, verbatim): "en la ui de ingest , hay botones en cada recurso para ingent hay ingest y remove ademas quisiera un check en los items ya ingestados, y quiero saber que hacer remove me gustaria que dispare una compilacion que haga delete, asi que dime que requieres del backend , que enpoints"

L2 (human, relayed by the Chief): (a) marking = ingested and current by hash, a changed file drops the mark by itself; (b) Remove decides nothing on our side, the panel only calls the retraction endpoint and llm-wiki owns the rest, no conditional branch on `current` in the client or the handler; (c) reversible: re-ingesting the same file restores the content, no permanent tombstone; (d) data model 1:N, one document with one ingest state per stack.
