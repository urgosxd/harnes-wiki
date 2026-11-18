# Feature: ingest-dimensions-union

The ingest job panel dropped the pipeline's two state machines whenever the payload carried a
`dimensions` array, so a job whose compile was still running showed two green output rows and
nothing about the work in progress. This makes the panel a UNION: the fixed `Ingest` and
`Compile` sections always render, and the payload's per-dimension rows are appended. Scope:
`web/src/components/IngestJobView.tsx`, one comment in `web/src/lib/ingest.ts`, the web
component tests, and the feature documents.

Status: complete
Branch: fix/ingest-dimensions-union
Created: 2026-11-18
Requester: the repo owner

## Specs

S1 (verbatim, the report):

> "Todo bien pero veo que no sigues al job en la pagina de ingest debo darle al f5 porque sino se pierd el estado del job"

> "creo que si esta pero no muestra la epata de compilacion ni su estado"

The fixed `Ingest` and `Compile` sections render ALWAYS, whether or not `dimensions` is present.

S2. When `dimensions` is present and usable, its rows render IN ADDITION — after the fixed
two, in the producer's order.

S3. Deduplicate by name: a dimension whose name matches a fixed section's name (`ingest` /
`compile`, case-insensitive, trimmed) is NOT rendered as a separate row, because the fixed
section already carries it.

S4. The `Compile` section shows the stage AND the progress the payload carries, as its
`current`/`total` pair, never a percentage computed here; `Ingest`'s stage the same. Attempts
and a finished-at timestamp are shown when the payload carries them, and omitted silently
when it does not — no invented value, no placeholder that reads as data.

S5. Everything stays tolerant: a non-array `dimensions`, entries without a string
name/status, missing `progress`, missing `stage` — none of it throws and none of it blanks
the fixed sections. (S5 of `ingest-dimensions-array.md`, re-pointed at the union.)

S6. `isJobSettled` and the polling rule are NOT touched.

## Tasks

| ID | Task | Spec | Route | Commit |
| --- | --- | --- | --- | --- |
| T1 | Union of the fixed pair and the payload rows, dedupe by fixed name, finished-at line, inverted S4 test, supersede record | S1-S6 | inline | ee94301 |

## Log

L1 (request, verbatim):

> "Todo bien pero veo que no sigues al job en la pagina de ingest debo darle al f5 porque sino se pierd el estado del job"

and, clarifying:

> "creo que si esta pero no muestra la epata de compilacion ni su estado"

L2 (decision: S4 of `ingest-dimensions-array.md` is superseded, not corrected in place). The
live job the requester pasted, `ing_01M7RDTQ37RE057Z4JZB1ZFCKW`, ended the old rule:

| Dimensión | Estado |
| --- | --- |
| Ingest | succeeded — etapa `journaling`, "Source ingested.", 1 intento, cerrado 22:54:28 |
| Compile | **running** — etapa `page_generation`, progreso 0 / 43 páginas |
| wiki | succeeded — `wiki:created` |
| kg | succeeded — 6 chunks, 154 entidades, 71 tripletas rechazadas por ontología |

Four rows, together, and that grouping is the acceptance criterion. The old S4 — "when
`dimensions` renders, the two fixed sections are not ALSO rendered" — turned that payload into
two rows and dropped the only one that said what the job was doing right then. The array is a
per-output breakdown; `ingest`/`compile` are the pipeline's two state machines (status, stage,
attempts, progress). One does not replace the other, so the rule is superseded by this
document (recorded in the `## Supersedes` table of `ingest-dimensions-array.md`, whose S4 text
and log entries are left untouched) and the test that pinned it is inverted rather than
deleted.

L3 (what stays unproven): (a) no live host was contacted for this fix and no container was
started, so the payload shape is the one pasted in L2 — tolerance for a non-array, a missing
name/status/stage/progress is covered by tests over constructed payloads, not by a measured
sample from the producer; (b) the panel shows the pair exactly as the payload publishes it
(`0 of 43`) and adds no unit, because nothing in the payload names one — the requester's
"páginas" is the stage's implied unit, not a field, and inventing it would be the fabricated
value S4 forbids; (c) a settled state machine still renders `Reached: final` instead of its
last stage name, a rule reported and fixed earlier and pinned in
`web/src/components/ingest-jobs.test.tsx`, so the `journaling` in the requester's row is shown
as `final` and the stage name is not repeated.

L4 (delivery, two commits, and the slice boundary). The behaviour slice is `ee94301`: the
union, the dedupe, the finished-at line, the inverted test and the tolerance assertions,
420 changed lines raw and 217 with `git diff -w`. The gap is re-indentation, not work: the
old branch sat two levels deeper inside a fragment, so moving the fixed pair out of it
re-indents ~76 lines of `IngestJobView.tsx` without changing a character of them, and the raw
figure counts each as an insertion plus a deletion. The second commit carries the record —
this document, its census line in `server/test/feature-doc.test.ts`, and the `## Supersedes`
table in `ingest-dimensions-array.md` — because a document cannot name the commit that
contains it. `README.md` was not touched: it describes the two dimensions, not the rendering
order, and nothing there became false. `web/src/styles.css` was not touched either: the grid
is `repeat(2, minmax(0, 1fr))` and four sections wrap into two rows on their own, so the
union needed no layout rule.
