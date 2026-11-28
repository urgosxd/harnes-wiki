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
- S4 — UI mark, three states. Route: worker. Commit `fba2f0c`.
- S5 — `POST /:id/retract` (503 while E7 pending). Route: worker. Commit `e6ef89f`.
- S6 — `DELETE` 409 guard. Route: worker. Commit `5aebe6b`.

## Open risks

- **ACCEPTED LIMITATION, owner decision pending: `retracted` is written on ACCEPT, not on
  settlement.** `POST /documents/:id/retract` sets `document_ingests.last_status =
  'retracted'` as soon as the wiki ACCEPTS the deletion, because the answer is `202 { jobId }`
  and this deployment follows no job (E7's deletion and its compile are one call upstream, and
  job settlement is the wiki's). Consequence: if the compile that follows the deletion FAILS,
  our row still reads `'retracted'` while the wiki still holds the content — so `DELETE
  /documents/:id` (S6) is allowed for a document whose compiled source upstream never really
  went away. The mark is also what S4's listing reports as `current: false`, which is a second
  place the same optimism is visible. Fixing it properly means job-settlement tracking (poll
  the returned jobId to a terminal state, and only then write `'retracted'` — or write it and
  revert on a failed compile), which is a bigger change than this step and is NOT in it. Named
  here so the owner can accept it or ask for it. A re-ingest resets the row either way, so the
  damage is bounded and reversible.

- **Wiki envelope assumed, not recorded; NOT closed in S5.** The
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

L8 (worker): the web half of S5 is now PINNED by a committed test, in `241c70c`
(`test(web): pin the document refusal notices`) — one file, `web/src/components/ingest-jobs.test.tsx`,
+86 lines, no product code touched. L7 proved the mapping `document_not_ingested` → the
server's sentence with a throwaway out-of-worktree probe, because that file was outside its
surfaces; a probe leaves nothing behind, so a later edit could have dropped the code from
`DOCUMENT_REFUSAL_CODES` with every test still green. What is now pinned, and why in these
places:
  1. TWO PURE CASES in a new block next to the delete guard's
     (`noticeFor: 409 document_not_ingested is a document fact too`): the server's sentence
     reaches the notice VERBATIM and WHOLE (`toEqual` on the full string, no code prefix, and
     explicitly not the concurrency sentence), and the empty body falls back to our own
     sentence asserted character for character, so a later edit to that fallback is a visible
     diff. `document_not_ingested` is reachable from every documents call, so the mapping is
     the right thing to pin; the two cases issue no request, which is why the request
     assertion lives in the third.
  2. ONE END-TO-END CASE in the panel block, next to S4's `document_ingested` case: the same
     code driven through the REAL hook and REAL client over the recording transport, the
     alert's WHOLE text compared to the server's sentence, and every recorded wire asserted to
     carry no `x-user-id` / `x-dev-token`. The wire answer carries the code on purpose — no
     client call asks for it until S7 wires the retraction button, so which endpoint produces
     it is S7's business and what the notice says is this file's.
  3. THE FOUR NEIGHBOURS ALREADY PINNED, verified rather than duplicated: `job_still_working`
     and `job_changed` (code-prefixed, exact) and `busy` plus the code-less lock (the byte-for-
     byte concurrency sentence) are all asserted with literal equality in
     `describe("noticeFor: a 409 is two different facts")`. Nothing was added there.
  4. OBSERVATION FOR S7, not changed here: with an empty body, `document_not_ingested` falls
     back to the DELETE guard's sentence — "This document is ingested; retract it before it can
     be deleted." For a document with NO ingest that sentence states the opposite fact. It is
     pinned exactly as it behaves today (this step preserves, it does not fix), and it becomes
     user-visible the moment S7 calls the retract endpoint and it answers without a body. One
     line in `documentRefusalMessage` would give that code its own fallback; that is a copy
     decision for the owner, not a defect a test should silence.
  Evidence: `npx vitest run src/components/ingest-jobs.test.tsx` 73/73 (70 before, +3),
  `cd web && npx vitest run` 382/382, `npx tsc --noEmit` clean, `cd server && npm test` 552/552
  unchanged. No RED is claimed — this is a PRESERVE step and the behavior already existed — so
  the test's non-vacuity was proven by MUTATION instead: with `"document_not_ingested"` removed
  from `DOCUMENT_REFUSAL_CODES` in `use-ingest.ts`, exactly the three new cases fail (the two
  pure ones on the deep-equality of the sentence, the end-to-end one on
  `'Another ingest is running. That is a …'` where the server's sentence was expected) and the
  other 70 pass; restored, `sha256sum -c` on the saved copy is OK, `git diff` for
  `use-ingest.ts` is empty, and the file re-runs 73/73. Which sentences a `409` carries is
  therefore load-bearing in versioned evidence, not in a probe.
  Slice note for the transaction controller: the branch is at 3532 authored changed lines in
  13 commits since `main`, past the ~400-line work-unit slice, and `241c70c` is a 86-line
  addition on top. Delivery slicing of the feature branch is NOT this step's decision and was
  not taken here; recorded so the boundary is not lost.

L7 (worker): S5 landed in `e6ef89f` (`feat(api): add document retraction gated on an enable
flag`) — `server/src/api/document-retraction.ts` (new), `server/src/api/document-routes.ts`,
`server/src/ingest/client.ts`, `server/src/db/document-store.ts`, `server/src/config.ts`,
`server/src/main.ts`, `server/test/documents-retract.test.ts` (new), `web/src/lib/use-ingest.ts`,
`README.md`. What it is, and the decisions that are not obvious from the diff:
  1. THE ORDER OF THE ANSWERS. `findOwned` first (a `409`/`400`/`503` for a foreign document
     would confirm it exists; the foreign answer stays the byte-identical `404 { error:
     "not_found", message: "no such document" }`), then `x-stack-id` (`400 invalid_stack_id`:
     a retraction deletes and recompiles ONE Stack, so "no Stack" has no default), then the
     deployment capability (`503 source_retraction_unavailable`), then the local gate, then the
     identity, then the upstream call. The capability check sits BEFORE the local gate on
     purpose: a deployment that can never retract must not answer `409 document_not_ingested`
     and send a client down a path that cannot work there.
  2. NEVER INSPECTS `current`, in the handler or in the adapter. The only local gate is the
     presence of a `document_ingests` row for (document, Stack). The hash comparison that
     remains — `matchingWikiSource` from `document-ingest-state.ts` — answers a DIFFERENT
     question: which of the wiki's sources ARE these bytes, i.e. the identity a deletion must
     address. Finding no row there is not "there was nothing to retract"; it is "no identity to
     address", answered `503` with zero upstream DELETEs and never guessed or sent blank.
  3. THE IDENTITY IS THE WIKI'S `storage_path`, read fresh from `/stacks/<id>/documents` (no
     cache: a retraction happens right after a compile and a 5 s stale listing may not carry the
     source it just wrote), and sent as ONE encoded path segment. Proven on the wire with
     `wiki/sources/informe final.md` → `/stacks/<s>/sources/wiki%2Fsources%2Finforme%20final.md`.
     `IngestClient.deleteSource` documents why this family uses PATH segments while the job API
     keeps `?stackId=`.
  4. ONE CODE FOR "THERE WAS NOTHING TO RETRACT". An upstream `404` (whatever it calls it)
     becomes our `409 document_not_ingested` carrying the wiki's own sentence verbatim; an
     upstream `409` becomes our `409 busy` with its sentence; any other status is `502
     ingest_service_error`, and an unreachable service is `502 ingest_service_<reason>` — the
     vocabulary `ingest-routes.ts` already answers with.
  5. `markRetracted` is a dedicated statement, not `recordIngest(..., 'retracted')`: the upsert
     RESETS `job_id`, and a retraction is not a job — overwriting the ingest job id would make
     the listing report a job the panel cannot follow. It updates and never inserts: no row is
     the gate, so a row that vanished mid-flight is a document that was deleted, not a state to
     invent.
  6. CONTRACT-vs-TEST CONFLICT, resolved toward the test: the Contract above says `404
     document_not_found`, and this step's test contract says the foreign answer must be
     byte-identical to the existing `404`. Byte-identical wins — the existing shape leaks
     nothing and a distinct code would be an observable difference nobody asked for. So
     `document_not_found` is realized as `{ error: "not_found", message: "no such document" }`.
     Recorded here rather than silently: if the owner wants the distinct code, it is one line.
  7. ENABLE FLAG, this is how S5 ships without E7: `SOURCE_RETRACTION_ENABLED`, default OFF,
     parsed with the same `flag()` helper as every other boolean in `config.ts`, carried by
     `main.ts` into `DocumentRetraction` and documented in the README config table. Off means
     `503` naming the variable, no identity resolved, no upstream call, row untouched. No second
     flag. `IngestClient.deleteSource` exists and is exercised by the enabled path, so the day
     E7 deploys the switch is configuration and nothing else.
  8. NO BUTTON WAS WIRED: `IngestJobsPanel.tsx` is untouched and `Remove` still calls
     `DELETE /documents/:id`. The one web change is `document_not_ingested` joining
     `DOCUMENT_REFUSAL_CODES` in `use-ingest.ts`: without it, S5's new code would fall through
     to "Another ingest is running…" the moment S7 wires the button.
  Evidence: `server/test/documents-retract.test.ts` 11/11 (RED first: the file failed to load
  against `427994d` — `document-retraction.ts` absent — and the mutation pass below is what
  makes that count), `cd server && npm test` 552/552, `npx tsc --noEmit` clean, `cd web && npx
  vitest run` 379/379, `npx tsc --noEmit` clean. Mutation-checked once, three mutations at once,
  exactly the intended cases failing and no others: the `x-stack-id` guard disabled → case 3
  fails; the `SOURCE_RETRACTION_ENABLED` branch disabled → case 4 fails; the identity sent
  un-encoded → cases 5 and 10 fail (both assert the raw path). Reverted and re-run 11/11.
  Proven by execution: every status and body above, the zero-upstream-call property of all five
  refusals, the DELETE path and its encoding, the row transitions (`requested` → `retracted`),
  the reversibility through `recordIngest`, and the scope of the gate to (document, Stack).
  Read from code, not executed: the `main.ts` wiring (the retraction is constructed there and
  exercised in tests through the same constructor), and the web mapping of
  `document_not_ingested`, which was proven by a throwaway out-of-worktree probe (the sentence
  reaches the notice verbatim while `busy` keeps the concurrency sentence) because
  `web/src/components/ingest-jobs.test.tsx` is outside this step's edit surfaces.
  Still open, for the owner: the accepted `retracted`-on-ACCEPT limitation in `## Open risks`,
  and the wiki envelope risk, which S5 did NOT close (the upstream service was not running and
  its contract document is outside this project root; `readWikiRows` remains the single tolerant
  reader, now also feeding identity resolution).

L6 (worker): S4 landed in `fba2f0c` (`feat(web): mark ingested documents and show the delete
refusal`) — `web/src/lib/api.ts`, `web/src/lib/use-ingest.ts`,
`web/src/components/IngestJobsPanel.tsx`, `web/src/components/ingest-jobs.test.tsx`. S1, S4
and S5's UI half are what this covers; S3/S6 (the retract endpoint) are not the UI's and stay
open.
  1. The mark has THREE states, and `current?: boolean` is how the third one survives the
type system. `DocumentIngestState` declares `current` optional because the server omits the
key when `known: false`; a required `boolean` would force the surface to invent "not
ingested" out of "could not look". `documentMark()` in the panel maps: `contentHash: null`
→ nothing (no content identity, no error tooltip either); `known: false` → a `data-ingest-state="unknown"`
mark reading `no data` with a tooltip naming the unread wiki; `current: true` → `data-ingest-state="current"`
with `✓`; `current: false` → nothing at all. "Not ingested" is therefore silence, never a
claim.
  2. `ListedDocument extends UploadedDocument` instead of widening `UploadedDocument`. The
upload answer (`POST /documents`, 201) carries neither `contentHash` nor `ingest`, so putting
those on the shared type would have made every upload look already checked against the wiki.
Only `listDocuments()` answers `ListedDocument[]`.
  3. THE DEFECT S4 EXISTS FOR: `noticeFor` mapped every `409` without a job-control code to
"Another ingest is running", so S6's `document_ingested` delete refusal would have been
reported as a concurrency lock — false, and it would have dropped the one part of the answer
that names the fix. There are now two allow-lists, `JOB_CONTROL_REFUSAL_CODES` and
`DOCUMENT_REFUSAL_CODES`, so the next refusal (S5's `document_not_ingested`) is added in one
place. A document refusal reaches the screen VERBATIM (no code prefix), because the sentence
itself names `POST /documents/<id>/retract`; only a body that says nothing falls back to our
own "retract it before it can be deleted". The lock and both job-control sentences are
byte-identical to before.
  4. `Remove` is untouched as an ACTION: it still calls `removeDocument` → `deleteDocument` →
`DELETE /api/documents/:id` (S7 owns retracting). What changed is that the row now says
BEFORE the click that removing an ingested document needs a retraction this panel cannot ask
for yet, and the refusal itself reaches the existing `documentsNotice` channel so the row
stays listed.
  5. CORRECTION TO THE S6 REPORT, recorded because a false claim left standing is worse than
the bug it hides: "no `web/` DELETE caller exists (`grep` for `method: \"DELETE\"` is empty)" is
WRONG. A `web/` DELETE caller exists and always did: `web/src/lib/api.ts:350`
(`deleteDocument` → `this.request("DELETE", /documents/<id>)`), reached from
`web/src/components/IngestJobsPanel.tsx:304` (`Remove`) through `web/src/lib/use-ingest.ts:391`
(`removeDocument`). The grep was empty because this client passes the VERB as a positional
argument (`request("DELETE", path)`, `web/src/lib/api.ts:442`); `method: "DELETE"` appears
only in test wire assertions, never in product code. So S6's guard protects a path the UI
already uses, which is what makes this step's refusal copy load-bearing rather than
defensive.
  Evidence: `npx vitest run src/components/ingest-jobs.test.tsx` 70/70 (RED first: 6 of the 8
new cases failing against `5aebe6b` — every case that needed a mark or the document notice;
the two negative cases, "no mark for a not-ingested row" and "no mark for a legacy row",
passed before the change and still do, which is what they are for), `cd web && npx vitest run`
379/379, `npx tsc --noEmit` clean, `npm run build` clean, `cd server && npm test` 541/541.
Proven by execution: the three rendered states, the single listing read, the verbatim refusal
on a real 409 through the real hook and client, exactly one DELETE, the row surviving it, and
no `x-user-id`/`x-dev-token` on any request. Read from code, not executed: nothing — the
mark's data arrives from the S3 listing already pinned server-side.

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
