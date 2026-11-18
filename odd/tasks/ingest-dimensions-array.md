# Feature: ingest-dimensions-array

The ingest job payload carries a `dimensions` array of per-dimension results (`wiki`,
`kg`, …). The panel ignored it: it declared only `ingest` and `compile`, cast the body
blindly, and rendered two hardcoded sections, so `wiki:created` and
`kg: N chunks, M entities` never reached the screen and a failed `kg` under a
`succeeded` overall status was indistinguishable from success. Scope: the web job
contract and view, one server passthrough pin, `README.md`, this document.

Status: in progress
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
| T1 | Tolerant reader for `dimensions` + the rendered rows, the passthrough pin, `README.md` and this document | S1-S10 | inline | pending |

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
