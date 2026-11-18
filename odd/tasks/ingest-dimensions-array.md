# Feature: ingest-dimensions-array

The ingest job payload carries a `dimensions` array of per-dimension results (`wiki`,
`kg`, …). The panel ignored it: it declared only `ingest` and `compile`, cast the body
blindly, and rendered two hardcoded sections, so `wiki:created` and
`kg: N chunks, M entities` never reached the screen and a failed `kg` under a
`succeeded` overall status was indistinguishable from success. Scope: the web job
contract and view, one server passthrough pin, `README.md`, this document.

Status: complete
Branch: feature/ingest-dimensions-array
Created: 2026-11-18
Requester: the repo owner

## Specs

S1 (verbatim, the request, and the payload the requester pasted):

> "si haz la fature, lee las dimensiones y renderiza"

> "Lo que vas a ver ahora, literal"

```json
"compile": { "status": "succeeded", "message": "Compiled wiki and kg." },
"dimensions": [
  { "name": "wiki", "status": "succeeded", "summary": "wiki:created" },
  { "name": "kg",   "status": "succeeded", "summary": "kg:N chunks, M entities" }
]
```

S2. When the job payload carries `dimensions` as an array of objects, the panel renders ONE
row per dimension: its `name`, its `status` as a badge, and its `summary` text when it is a
string. No fixed names — a dimension called `kg` or `qa` renders exactly like `wiki`.

S3. `ingest` and `compile` remain the fallback for jobs that carry no usable `dimensions`:
such a job must render EXACTLY as it does today, same labels (`Ingest`, `Compile`), same
structure, same testids.

S4. When `dimensions` renders, the two fixed sections are not ALSO rendered — no duplicated
rows for the same job.

S5. Tolerance: a non-array `dimensions`, an entry that is not an object, an entry without a
string `name`, or non-string `status`/`summary` must never throw and never invent a value.
Skip what cannot be rendered; if no valid entry remains (including an empty array), fall back
to the fixed two rows per S3.

S6. Display-level truth: a dimension whose status differs from the job's overall status shows
its OWN badge. A failed `kg` is visibly failed even when `compile.status` is `succeeded`.

S7. The poll's settle rule is UNCHANGED: `isJobSettled` keeps reading `ingest`/`compile`
(`web/src/lib/ingest.ts`). Whether a dimension can settle before the overall status is
UNVERIFIED, and moving the settle rule onto an unverified assumption could leave a job
polling forever. Stated in a code comment where the reading happens and in this document's
Log.

S8. No server change: the route already forwards the body untouched. Add ONE server test
pinning that a job carrying `dimensions` reaches the client unchanged.

S9. `README.md`: document the per-dimension rows and keep the existing statement that a job
ends only when both named dimensions are terminal — it remains true and must not be
contradicted.

S10. Feature document `odd/tasks/ingest-dimensions-array.md` plus its entry in the literal
census array in `server/test/feature-doc.test.ts`.

## Tasks

| ID | Task | Spec | Route | Commit |
| --- | --- | --- | --- | --- |
| T1 | Tolerant reader for `dimensions` + the rendered rows, the passthrough pin, `README.md` and this document | S1-S10 | inline | 1d6cd75 |

## Supersedes

| Spec | Superseded by | Why |
| --- | --- | --- |
| S4 | `odd/tasks/ingest-dimensions-union.md` S1-S3 | The array is a per-output breakdown, not a replacement for the two state machines. Rendering it INSTEAD OF the fixed pair hid the only row that said what the job was doing at that moment. Everything else in this document stands. |

## Log

L1 (request, verbatim):

> "si haz la fature, lee las dimensiones y renderiza"

and, from the requester, verbatim:

> "Lo que vas a ver ahora, literal"

```json
"compile": { "status": "succeeded", "message": "Compiled wiki and kg." },
"dimensions": [
  { "name": "wiki", "status": "succeeded", "summary": "wiki:created" },
  { "name": "kg",   "status": "succeeded", "summary": "kg:N chunks, M entities" }
]
```

L2 (decision, S7): the settle rule stays on `ingest`/`compile` and is not moved onto
`dimensions`. A dimension is a report about a unit of work; the job's lifecycle is the pair
the service documents as two state machines, and the poll already stops only when both halves
are terminal. Moving `isJobSettled` onto an array whose terminal vocabulary is unknown would
mean guessing which dimension words end a job — and a wrong guess either freezes the screen on
live work or polls a dead job forever. `isJobSettled` is unchanged and carries a comment where
it reads the pair; the array is now rendered and nothing more.

L3 (what stays unverified): (a) whether a dimension can reach a terminal status BEFORE the
overall job status does — nothing in this repository observes the producer's scheduler, so the
settle rule cannot be built on it; (b) the host's real payloads — the shape is taken from the
requester's paste, so an entry that is not an object, a missing `name` or a non-string
`summary` is handled by tolerance rather than by a measured sample. If the producer ever emits
a dimension that settles first, the poll keeps waiting on `ingest`/`compile` and that is the
honest behaviour until the ordering is measured.

L4 (delivery, one commit): the owner asked for ONE commit, so this document travels inside
the commit that closes T1 and cannot name that commit's SHA — a commit cannot contain its own
hash. The Commit cell therefore reads `pending` and the header stays `Status: in progress`,
which is what `server/test/feature-doc.test.ts` requires of a pending row; the SHA is reported
in the handoff and a one-line `docs(odd)` follow-up would record it if the owner asks for one.

L5 (closing, the SHA L4 could not carry): T1 landed as `1d6cd75`, which is now the Commit
cell and the header reads `Status: complete`; this entry is the `docs(odd)` follow-up L4
anticipated. The review workload is worth naming because the raw figure misleads: one commit
of 1026 changed lines (947 insertions, 79 deletions), and most of it is new test text —
`ingest-dimensions.test.tsx` (276), `ingest.test.ts` (151) and
`ingest-dimensions-passthrough.test.ts` (151). `git diff -w` over the same commit reports 871
insertions and 3 deletions, and ~76 of the difference in `IngestJobView.tsx` (151 added
becomes 75) is pure re-indentation of the fallback block, moved inside the new branch without
a character changed. The substantive additions are therefore roughly 293 lines — the reader,
the rows, the passthrough pin and the `README.md` section — not a thousand. One interface
change rode along: `StatusBadge`'s `settled` prop became optional so a dimension row can omit
a word it cannot honestly claim (S6, and the comment at the badge says why), while both fixed
call sites — `ingest` and `compile` — still pass it and `ingest-jobs.test.tsx` still asserts
`data-settled` on those two columns, which is what keeps S3's "renders exactly as it does
today" honest.

L6 (S4 superseded, reported defect): a live job — `ing_01M7RDTQ37RE057Z4JZB1ZFCKW` — arrived
with `compile` still `running` on `page_generation` at 0 of 43 pages while `dimensions`
already reported `wiki` and `kg` as `succeeded`. Under S4 the array was non-empty, so the two
fixed sections were never rendered and the panel showed two green rows for a job that was
still working; the requester had to reload the page (F5) to see the compile at all. The rule
was wrong, not the payload: `ingest`/`compile` are the pipeline's two state machines (status,
stage, attempts, progress) and `dimensions` is the per-output breakdown, so one cannot
substitute for the other. S4's text is left untouched — editing a spec to agree with a later
decision erases the record of the decision — and is marked superseded by
`odd/tasks/ingest-dimensions-union.md` in the `## Supersedes` table above. Its test in
`web/src/components/ingest-dimensions.test.tsx` is inverted, not deleted, with a comment
saying which spec it used to pin.
