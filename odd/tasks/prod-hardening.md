# Feature: prod-hardening

Four defects that make the agent fail in production, each one reviewable and revertable on
its own: a failed turn reporting no cause, a shipped role asking for tools the deployment
does not grant, coding tools reaching outside the workspace, and a CI gate whose
credential-less skip depended on running as root.

Status: complete
Branch: feature/prod-hardening
Created: 2026-11-18
Requester: the repo owner

## Specs

S1 (verbatim, the request):

> "arregla las cosas anotadas nececisatmos que el agente no falle para prod"

S2. A turn that fails tells the caller WHY. An exception thrown by the awaited work —
`session.prompt`, or any awaited step before the turn settles — must reach the caller: the
`TurnResult` carries the thrown cause in `errorMessage`, and the `run_failed` frame carries
the same words. A `return` inside `finally` must not discard it, which is what used to
produce `outcome: "error"` with `errorMessage: undefined`.

S3. The settlement duties still run on the throwing path, exactly as they did on the
normal one: the transcript is read **before** `dispose()` (the in-memory manager is the
only record of what this turn appended), the session is disposed, and `store.append` is
called once with the entries this turn appended.

S4. A thrown cause outranks the transcript: a turn that threw is always `error`, never
`ok`, and its message is the thrown one. The transcript's own `errorMessage` is the
fallback only for the path where nothing was thrown at all, and a blank reason counts as
no reason so the caller falls back instead of showing an empty cause.

S5. Every read-only tool the shipped role names is provisioned.
`server/agents/wiki-agentic-search.md` is a shipped role and its body tells the model which
tools to call, so a grant list in `server/scripts/provision-mcp.mjs` that omits one of them
ships a role asking for tools it does not have. Both spellings the body uses count: the
qualified `mcp__llmwiki__<tool>` form, and the bare name in backticks (which is how
`query_stack` appears). The role's `read_page` and `query_stack` were the two that were
missing; the grant list goes from nine tools to eleven.

S6. No mutating tool is granted. The five tools that write to the wiki host —
`ingest_source`, `compile_wiki`, `export_okf`, `import_okf`, `run_eval` — stay out, because
this product never decided to expose them. The list is spelled out, never inferred from a
tool's name.

S7. A test pins the agreement in both directions, reading the role file itself rather than
a copy: every tool the role names is covered by provisioning (a subset assertion — the role
says what it must be able to do, not that the deployment may expose only that), and no
mutating tool is granted. The extractor is also proven live on both spellings, so the
coverage assertion cannot pass vacuously.

S8. `grep`, `find` and `ls` refuse any path that resolves outside the workspace, with the
same `PathEscapeError` vocabulary `read` already refused with, and before any filesystem
effect. Their operations seam cannot carry this check, so the `path` argument is checked
before the tool runs at all: `find` swaps fd for a custom `glob()` the moment one is
supplied, and grep rewrites a thrown `isDirectory()` into "Path not found".

S9. `write` and `edit`, when `AGENT_WRITES` is on, refuse the same way. A refused mutation
creates nothing and modifies nothing: no file outside the workspace, no parent directory
outside it, and the credential file left byte-identical. A write's leaf may not exist yet,
so the check resolves where the request really lands rather than relying on `realpath` of
the leaf alone.

S10. The escapes covered are absolute paths, relative paths, `..` traversal, a
directory-symlink escape, a symlink inside the workspace whose name looks contained, and a
dangling symlink that points outside it. A path outside the workspace that does not exist
is refused too, which is what proves the check runs before any access. The path is resolved
the way the coding tools resolve it — `~`, a leading `@`, unicode spaces, `file://` URLs —
because a check reading `~/secrets` as `<workspace>/~/secrets` would allow the read it sits
there to stop.

S11. `read`, `isInsideRoot` and `confinedReadOperations` are unchanged in behaviour: same
refusal outside the workspace, same answer inside it.

S12. No new configuration knob. The confinement is unconditional, not opt-in through an
environment variable, so a default deployment is the confined one.

S13. `scripts/ci.sh` must not make the credential-less tier skip by naming an absolute path
the running user cannot write. pi-coding-agent creates the directory it is handed, so that
path failed the tier with `EACCES` and four failing tests on any non-root host while staying
green in the image, whose test stage runs as root. The script creates an **empty writable
directory it owns** (`mktemp -d`), mounts it at the same path so the container finds an
existing directory whatever uid it runs as, passes it as `PI_AGENT_DIR`, and removes it on
exit.

S14. The skip signal is the **content** of the auth file, not its existence. Absent,
zero-length, whitespace-only and `{}` all mean no credentials — `AuthStorage` writes `{}`
into the directory it is given, so existence alone made an empty directory look like a
machine with credentials to every test process starting after that write, and the tier ran
and failed instead of skipping. Any non-empty object means configured, and a file that is
present but unparseable counts as configured so a broken credential file fails the tier
loudly instead of quietly skipping it.

S15. The predicate is defined once. `hasCredentials()` lives in `server/test/support/env.ts`
and `server/test/support/harness.ts` re-exports it: a rule that decides whether the live
tier runs or skips must not exist twice.

S16. The claims this work falsified are corrected, in `README.md` and in
`odd/tasks/skills-volume-and-role.md`: the confinement sentence (all of `read`, `grep`,
`find`, `ls` and, under `AGENT_WRITES`, `write`/`edit` are confined, and `bash` is not and
is off by default); the claim that `read_page` is deliberately not granted; the claim that
the admin surface exposes three tools; the claim that the CI tier skips because
`PI_AGENT_DIR` is missing; the role/provisioning mismatch recorded as an open limitation
(now closed, with the commit named); and the `ls`/`grep`/`find` finding, which gets a new
appended `L8` rather than a rewrite, because this repository's logs are append-only and the
existing `L3` records what was true when it was written.

S17. This document, and its deliberate entry in the census array in
`server/test/feature-doc.test.ts`.

## Tasks

| ID | Task | Spec | Route | Commit |
| --- | --- | --- | --- | --- |
| T1 | A failed turn reports its cause: `catch` records the throw, the `finally` keeps its settlement duties and captures instead of returning, the thrown cause outranks the transcript, plus `turn-error-reporting.test.ts` | S2-S4 | worker (disjoint file set), verified inline | `25bca9c` |
| T2 | Role/provisioning agreement: `read_page` and `query_stack` granted (nine to eleven), and a test that extracts both tool spellings from the role file and pins coverage plus no-mutating-tool | S5-S7 | worker (disjoint file set), verified inline | `df51ed6` |
| T3 | Tool confinement: `grep`, `find`, `ls` and (under `AGENT_WRITES`) `write`/`edit` refuse paths outside the workspace before any filesystem effect, plus `sandbox-tools.test.ts` covering absolute, relative, `..`, directory-symlink and dangling-symlink escapes | S8-S12 | worker (disjoint file set), verified inline | `7264a1f` |
| T4 | CI gate honesty: `mktemp -d` for `PI_AGENT_DIR` with cleanup, and a content-aware `hasCredentials()` defined once and re-exported, plus `ci-gate-contract.test.ts` coverage in both directions | S13-S15 | worker (disjoint file set), verified inline | `189d8a2` |
| T5 | The six corrections in `README.md` and `odd/tasks/skills-volume-and-role.md`, this document, and its census entry | S16-S17 | inline (parent) | this commit — a commit cannot name itself, see `L6` |

## Log

L1 (requester's original request, verbatim):

> "arregla las cosas anotadas nececisatmos que el agente no falle para prod"

L2 (the four-unit split, and why):

- **Four units, four commits, in the order the request implies.** The four findings came
  from the same audit but share nothing: a session-factory control-flow bug, a grant list,
  a path boundary, and a test-harness signal. Each one is reviewable alone and revertable
  alone, and the order is by how directly it makes a turn fail in production: a turn with
  no cause first, then a role whose instructions cannot run, then the boundary, then the
  gate that tells you about the rest.
- **Disjoint file sets, one worker each.** `session-factory.ts` + its test; the two
  `provision-mcp` files + its test; `sandbox.ts` + `agent-tools.ts` + its test; `ci.sh` +
  three `server/test/support` and gate files. No two units write the same file, so the
  workers could not collide, and `git status` before the first commit was checked against
  this list: 12 files, every one accounted for, nothing swept in.
- **The document and the corrections are one `docs` commit at the end**, not four, because
  a feature document's Commit cells can only name SHAs that exist, and the six corrections
  are consequences of the four commits rather than separate work.

L3 (two premises the workers corrected from my briefs — both of them mine, both wrong):

- **Provisioning already granted nine tools, not three.** My brief said the role needed
  three tools and only some were granted. The audit measured it: `STACK_TOOLS` held three
  and `READ_ONLY_WIKI_TOOLS` six, nine in total, and the two actually missing were
  `read_page` and `query_stack` — one arriving in the qualified spelling and one only bare,
  in backticks, which is the spelling a naive extractor would have missed. The count that
  matters is now pinned by a test rather than asserted in prose.
- **The `mktemp` mechanism alone would have made the credential tier FAIL on every host.**
  My brief treated "point `PI_AGENT_DIR` at an empty directory" as the whole fix. It is
  half: `AuthStorage`'s constructor writes `{}` into whatever agent directory it is handed,
  so the directory stops being empty for every test process that starts after it, and an
  existence check then reads `{}` as "this machine has credentials" — the tier runs and
  fails instead of skipping, which is the same class of bug being fixed. The content-aware
  signal (`{}`, empty and whitespace are not credentials) is what makes the skip honest;
  the `mktemp` is what makes it independent of the uid.

L4 (what remains unproven):

- **No live MCP host was contacted.** The host's real tool vocabulary is not measured
  here: `provision-mcp.mjs`'s own comment says the service offers fifteen, and the mutating
  list names five. The grant list is now pinned against the ROLE, which is the artifact
  this repository ships, not against what the host advertises.
- **No container, no image, no Postgres was started.** The CI gate's credentials path is
  asserted as wiring and as the predicate's behaviour; a real run of `scripts/ci.sh` —
  with its mount, its `mktemp -d` and its trap under a non-root uid — was not observed.
- **The SSE path for a throwing turn was not observed end to end.** The cause is proven to
  reach `TurnResult`, which is what the transport serialises into `run_failed`; the frame
  itself was read from the source, not from a live stream.
- **A residual cwd assumption in the confinement.** The tools are also started with the
  workspace as their working directory, and the check judges the resolved `path`; a tool
  that resolved a relative path against a different cwd than this check assumes would be
  judged on the wrong absolute path. The resolution was reproduced from the SDK's own
  `resolveToCwd()` behaviour rather than calling it, since the package does not export it.

L5 (`bash` is still unconfined, reported and not fixed):

- **`bash` is not confined by any of this, and cannot be by a path check.** A shell reaches
  whatever the process can reach — measured earlier on the real stack, "run
  `cat /data/agent/models.json`" printed the provider key in full. It is off by default
  (`enableBash` is false unless `AGENT_BASH` is set), and enabling it re-opens the hole
  regardless of the per-tool checks added in `T3`. That is a capability decision for the
  requester, not something this feature closes, so it is recorded here and stated in
  `README.md` beside the confinement claim.

L6 (closing record, appended by this `docs` commit):

- **`T5`'s Commit cell cannot carry its own SHA**, because a commit cannot name itself.
  This entry is the record: it is the `docs` commit that holds the six corrections, this
  document and the census entry. The four unit commits are `25bca9c`, `df51ed6`,
  `7264a1f` and `189d8a2`.
- **The census entry was added deliberately**, as `S17` requires: the sentinel compares a
  literal array against the documents that really carry task rows, so a new document with a
  task table fails until its filename is written there.
- **The suite total moved with that entry, and only with it.** `feature-doc.test.ts` emits
  two tests per feature document ("no task with a commit is still pending" and "the rows and
  the header agree about what is pending"), so registering this document takes the server
  suite from 371 tests / 328 pass to 373 tests / 330 pass, with the 43 skips unchanged.
  Without saying so, the counts in `skills-volume-and-role.md`'s `L8` and in this
  document's report would look like they disagree.
- **One correction is a marked in-place edit, not an append.** In
  `odd/tasks/skills-volume-and-role.md`, `L4`'s role/provisioning bullet said `read_page`
  was deliberately left out of the grant list; it now records that the gap was closed and
  names `df51ed6`. That bullet was corrected in place because a reader who found
  "deliberately absent" would act on a false premise. The finding's own history was **not**
  rewritten: `L3` (the sandbox gap) and `L5`'s restatement of it stand as written, the
  confinement closure is a new appended `L8` there, and that document's header carries a
  note so a reader cannot take its `S5` for current state.

L7 (independent re-verification of the confinement fix, and the three advisories it left):

- **273 of the 273 probes the reviewer wrote pass on the fix, and 19 of them FAIL against
  the base commit.** Those 19 failures are the defects the fix closes: a symlinked
  `WORKSPACE_DIR` refusing everything, `read` of the workspace's own files included, and an
  unresolvable landing read as permission so the tool ran anyway. The probe set is the
  reviewer's, not this document's, which is what makes it evidence rather than a
  restatement of what the fix claims.
- **Both mutations fail the suite, which is how the probes were proven non-vacuous.**
  Reverting the real-to-real comparison — judging the landing against the textual root
  instead of the resolved one — breaks 8 of them; allowing an unresolvable landing to pass
  breaks 2. No escape and no weakened containment was found in either direction. The three
  durable probes now live in `sandbox-tools.test.ts`, so the next regression fails a test
  instead of needing another review.
- **Two docstring overclaims were corrected, and the code was not** (`9e2fb32`). A comment
  claiming safety the code does not have is a defect: "the root is resolved once" is false,
  because `resolveRealRoot` runs on every assertion with no caching; and "every caller
  treats that as a refusal rather than as permission" is inexact, because `resolveRealRoot`
  falls back to the textual root. The first now says the root is resolved at check time and
  every comparison is real-to-real; the second names the two call sites that refuse and
  states the one exception with the argument for why it cannot widen access — an
  unresolvable root makes every lexical descendant unresolvable too, so those requests are
  refused on their own landing before any comparison happens.
- **One deviation is ACCEPTED and recorded, not fixed.** A dangling `WORKSPACE_DIR` refused
  everything at base; it now lets `write path:"."` succeed at the link's own target. It is
  reachable only with a misconfigured root, it is not an escape, and `main.ts` creates the
  workspace before any runtime exists — so the behaviour stands as measured and `S8-S12`
  are not rewritten for it.
- **What stays open, and is nobody's task in this feature:** `read` of an image returns raw
  bytes because `confinedReadOperations` omits `detectImageMimeType` (pre-existing, not
  introduced here); `bash` is unconfined by design (`L5`); and the TOCTOU window between
  the check and the tool's own syscall is documented in `sandbox.ts` rather than closed.
- **The commit that holds the fix is `9e2fb32`**, the fifth on this branch. This entry is
  the sixth commit and cannot name its own SHA for the reason `L6` records.
