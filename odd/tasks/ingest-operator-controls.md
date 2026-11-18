# Feature: ingest-operator-controls

Two operator controls over the external ingest service: delete a liquidated job, and retry it.
Both are operations the service already offers and neither interrupts a running job, so this
feature adds a proxy and a UI over them; it invents no cancel. Scope: server routes and
adapter, the web panel, this document.

Status: complete
Branch: feature/ingest-operator-controls
Created: 2026-11-17
Requester: the repo owner

## Specs

S1 (verbatim, the request and the requester's trace of the other repository):

> "nueva feature, controles para el ingest:"

> "ingest_job_delete"

> "borra un job recuperable; el rechazo vuelve como payload de error"

> "POST /api/ingest/jobs/:jobId/retry"

> "job NUEVO desde el mismo source (:784) — id nuevo ing_${ulid()}"

> "Rechazos: 404 job_not_found, 409 job_still_working, 409 job_changed (api.ts:590-594)."

> "No existe cancel. Y el delete no interrumpe: lo rechaza con 409 job_still_working."

S2 (two routes, same gate as their neighbours). Our server answers
`DELETE /ingest/jobs/:id?stackId=` and `POST /ingest/jobs/:id/retry?stackId=`, forwarding to the
service's `DELETE /api/ingest/jobs/:jobId?stackId=` and
`POST /api/ingest/jobs/:jobId/retry?stackId=`. They carry the same `CHAT_USERS` identity as
`GET /ingest/jobs/:id`: an unauthenticated control answers `401` and never reaches the service,
and an unconfigured deployment answers `503 ingest_not_configured`.

S3 (`stackId` optional, in the query, never empty). Both routes read `stackId` from the query
and forward it as a query parameter. Absent — or blank — means the parameter is not sent at all,
never `?stackId=`: an empty value would name a Stack called `""`. The server stays tolerant
about the parameter while the web client stays strict about the link, as everywhere else.

S4 (status passthrough, the existing rule unchanged). Any upstream status `< 500` or `=== 503`
reaches the client with the upstream body byte for byte, which is what keeps `404 job_not_found`,
`409 job_still_working` and `409 job_changed` the host's own vocabulary. Any other 5xx becomes
`502 ingest_service_error`; an unreachable host becomes `502 ingest_service_<timeout|network>`.
No retry loop and no automatic repetition of a refusal: the proxy repeats nothing the host has
just said no to.

S5 (blank id refused before the call). An empty or whitespace-only `:id` answers
`404 job_not_found` and issues no upstream request, exactly as `GET /ingest/jobs/:id` does.

S6 (payload forwarded unchanged; the new id read tolerantly). The retry body is forwarded
byte for byte and this server never normalizes it. The minted job id is read from that body as
`jobId` first, then `id`, strings only (blank counts as absent) — `newJobId` in
`server/src/ingest/client.ts`. The same reading is what the web client does, so the two halves
agree without the payload being reshaped for either.

S7 (no cancel, and no claim of interrupting). No cancel endpoint is added at any layer, and no
surface states or implies that a working job can be stopped: a working job is REFUSED
(`409 job_still_working`) and keeps running.

S8 (documentation census). This document is added to the declared census in
`server/test/feature-doc.test.ts` (`"ingest-operator-controls.md"`, sorted), and `README.md`
gains the two routes with their rejection codes and the fact that a working job is refused
rather than interrupted.

## Tasks

| ID | Task | Spec | Route | Commit |
|---|---|---|---|---|
| T1 | Server half: `deleteJob` / `retryJob` on the adapter, the two routes beside the job reads, README ingest rows | S2-S4, S6, S7 | worker A | 086a075 |
| T2 | Server tests: RED first, then proving the sent verb/path/query, verbatim passthrough, the refusals not becoming `502`, the blank id, and the tolerant id read | S2-S6 | worker A | 086a075 |
| T3 | Web half: the two controls in the ingest panel, the payload read tolerantly, a refusal shown as a refusal and never retried automatically | S1, S2, S4, S6, S7 | worker B | 14cbccb, f42712e |
| T4 | Feature-document census line and reconciliation of the two halves | S8 | inline | 086a075 |

## Log

L1 (verbatim, the request):

> "nueva feature, controles para el ingest:"

The rest of S1 is the requester's trace of the other repository (llm-wiki), quoted there
verbatim because this repository documents none of that contract.

L2 (decision: scope, and one assumption). Delete + retry, tal como el servicio ya los ofrece —
no cancel: the service has no cancel operation, and delete does not interrupt a working job (it
refuses with `409 job_still_working`), so a cancel surface would be a lie about the operator's
data. A refused control is a visible failure and is never retried automatically.

The assumption that goes with it: the trace names `stackId` only for delete. Retry sends it as
well, for consistency with every other ingest call, which names the Stack in the query. That is
an ASSUMPTION about the host's retry route, not a documented fact — the host's own answer is the
authority, and if it rejects or ignores the parameter the fix belongs here rather than in a
guessed Stack.

L3 (delivery: two implementation commits, one regression, one assumption still open).

Delivered on `feature/ingest-operator-controls` in two implementation slices, plus the commit
that carries this evidence:

- `086a075` — server: `deleteJob` / `retryJob` on the adapter and the two routes beside the job
  reads, refusals forwarded verbatim, a `204` answered with no body and no declared length, the
  tolerant `newJobId`, the whole server suite for it (`test/ingest-controls.test.ts`), the
  README rows and the census line in `test/feature-doc.test.ts`. T1, T2, T4.
- `14cbccb` — web: the two controls in the panel, `deleteIngestJob` / `retryIngestJob` with the
  tolerant new-id read, per-control in-flight state, the rule that lays the row out inline, and
  the `409` fix below. T3.

One regression of existing behaviour was found while closing, and fixed in the web slice.
Worker B rewrote the SHARED `409` notice branch so it renders the host's own code and words.
That was right for `job_still_working` and `job_changed` and wrong for the other `409`: `start`
hitting the one-ingest-at-a-time lock had always answered "Another ingest is running. That is a
retry signal, not a failure.", the sentence disappeared, and the new test pinned the new copy,
so nothing guarded the old one. The branch now separates the two facts on the only evidence the
response carries — a `409` naming a job-control code keeps the host's words; anything else, the
`busy` lock or no code at all, restores the original sentence byte for byte, on `start` and on
the documents paths that share the mapping. Both facts are pinned by literal assertions.

Still unproven, and named here instead of implied: the host's real `204` / `202` bodies for
delete and retry, and the exact wording it uses for `job_changed`. S1's trace is a reading of
the other repository, not a captured response, so the adapter forwards the retry payload
untouched and reads the new id tolerantly rather than depending on a shape nobody has seen.
The retry `stackId` from L2 remains an assumption: it is sent for consistency with every other
ingest call and has NOT been verified against the host's retry route.

L4 (reconciliation: the fourth slice, the slice sizes, what stays unproven).

The delivery on `feature/ingest-operator-controls` is four commits: `086a075` (server),
`14cbccb` (web), `8b5f985` (documentation), `f42712e` (tests). The fourth is test-only — the two
web files that pin the `409` allow-list edges and the operator-control scope — and it is the
durable proof behind T3, so the table above now names it beside the web slice instead of leaving
that work resting on the commit it arrived in.

Slice sizes, entered as a reviewer-workload note rather than as an apology: slice 1 is ~690
authored lines and slice 2 is ~1140, both past the ~400 target. Neither was re-cut, because the
bulk is new tests (477 + 373 + 273 + 183) and the only split available separates a test from the
behaviour it proves; this repository ships behaviour and its proof in the same commit, so a
slice carrying one without the other would have to be trusted on its word.

The `409` regression an independent verifier caught, and the shape of the fix. The notice branch
is an allow-list now: a `409` naming `job_still_working` or `job_changed` renders the host's own
code and words, once. Everything else — a `409` carrying no code at all, and the `busy` lock
`start` hits — keeps the original sentence byte for byte: "Another ingest is running. That is a
retry signal, not a failure." Both sides are pinned by literal assertions.

Unverified against the host, named here instead of implied: the real `204` / `202` bodies for
delete and retry, the exact wording of `job_changed`, and the retry `stackId` query from L2.
S1's trace is a reading of the other repository, not a captured response, which is why the
adapter forwards the retry payload untouched and reads the new id tolerantly rather than
depending on a shape nobody here has seen.
