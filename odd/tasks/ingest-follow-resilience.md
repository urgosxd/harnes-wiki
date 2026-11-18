# Feature: ingest-follow-resilience

The ingest panel gave up on a job the first time a read failed, never refreshed its list on
its own, and came back from a reload following nothing — so a reload was the only way to see
a job's state again, and a single network blip froze the view while the job kept running.
Scope: `web/src/lib/ingest.ts`, `web/src/lib/use-ingest.ts`, the panel's wiring,
`web/src/lib/use-ingest.test.tsx`, `web/src/components/ingest-jobs.test.tsx`, `README.md`, and
this document with its census line.

Status: complete
Branch: fix/ingest-follow-resilience
Created: 2026-11-18
Requester: the repo owner

## Specs

S1 (verbatim, the report):

> "veo que no sigues al job en la pagina de ingest debo darle al f5 porque sino se pierd el estado del job"

S2. A network error, or a status that is neither `404` nor `503`, no longer ends the follow.
The last snapshot stays on screen, the poll keeps trying with the existing backoff
(`POLL_INITIAL_MS` 250 ms → `POLL_MAX_MS` 2 s), and the UI says it is reconnecting instead of
showing the job as failed.

S3. The retry is bounded by evidence, not by hope: when no read succeeds for the stall window
(reusing `STALL_AFTER_MS`, no second constant), the follow ends with the existing `error` stop
reason and a notice that names how long it went without an answer.

S4. A `404` that arrives after a snapshot exists, and a `503`, keep exactly the meanings they
have today. They are not folded into the retry.

S5. The jobs list refreshes on an interval while the panel is open and the surface has a
Stack. A refresh already in flight is not stacked on another, and no request is issued when
the surface is blocked for lack of a Stack.

S6. On mount, with nothing being followed, the most recently updated job whose state is still
running is followed automatically.

S7. That automation never overrides the user: an explicit follow of another job, a
`stopFollowing`, or the followed job settling ends it for that visit.

S8. `isJobSettled` and the settle rule are untouched. The dimension/union rendering and the
delete/retry controls keep working exactly as they do now.

S9. The new notices reuse the existing `IngestNotice` machinery: one notice object on the
channel the panel already renders. No new frame, and no new copy for a case that already has
words.

S10. The feature document and its census entry record the change.

## Tasks

| ID | Task | Spec | Route | Commit |
| --- | --- | --- | --- | --- |
| T1 | Keep following through a transient read failure, bounded by the stall window | S1-S4, S9 | inline | 32aadee |
| T2 | Refresh the list on an interval while the panel is open | S5, S9 | inline | a3d2ab4 |
| T3 | Re-attach to the most recently updated running job on mount, once | S6-S8 | inline | 48109dc |
| T4 | README, this document and the census entry | S10 | inline | carries this document |

## Log

L1 (the requester's original request, verbatim):

> "veo que no sigues al job en la pagina de ingest debo darle al f5 porque sino se pierd el estado del job"

L2 (the three gaps, each its own failure). Diagnosed before implementation, against the code at
`e79020d`:

1. **One transient failure killed the follow permanently.** `web/src/lib/ingest.ts:491-501` (the
   `fetch` threw) and `:535-546` (any non-ok status other than `503`/`404`) `return`ed out of the
   `for(;;)` loop with `reason: "error"`. There was no retry counter and no re-entry, so one
   network blip or one `502` left the UI frozen on the last snapshot while the job kept running on
   the server. This is a failure of the LOOP: nothing else in the panel could recover from it.
2. **The jobs list never auto-refreshed.** `refreshList` was wired to mount and to the actions
   (start, delete, retry, settle), and `web/src` contained no `setInterval` at all. A job that
   appeared in the Recent list stays absent, and a row that finished stays "live", until the user
   clicks Refresh. This is a failure of the LIST: the detail pane could be correct while the list
   beside it was stale.
3. **No re-attach after a reload.** `follow` was only ever reached from a user action — no job id
   in the URL, nothing in `localStorage`, no resume from the list — so a reload lost the follow
   and the panel opened on an empty detail pane. This is a failure of the VISIT: the state existed
   server-side and nothing on this side looked for it.

They are recorded separately because they are fixed separately: (1) is inside the poll loop, (2)
is a timer over the list read, (3) is a decision taken once per visit. Collapsing them into one
"polling is broken" would have hidden that (2) and (3) survive even with a perfect loop.

L3 (the decision: automatic re-attach, Option A, and what it excludes). On mount, with nothing
being followed, the hook follows the most recently `updatedAt` job whose state is still running.
No `job=` link parameter, and nothing in `localStorage`. The reason is the requester's own
complaint: pressing F5 must not be the way to get the state back, so the fix has to work for a
plain reload of the same link, and a link parameter would make the recovery depend on a user
editing the URL — the very action being removed. A stored id would be a remembered tenant-like
value on a surface whose whole Stack rule is "the link is the only source", so nothing is
stored. Out of scope, and recorded as such: there is **no `job=` parameter**, so a specific job
is still not shareable by link — sending someone a link to one job would need a new source of
truth about which job a page means, and that decision is not part of this fix. Also out of
scope: retry beyond the stall window (S3 forbids a second bound by construction), and any change
to `isJobSettled` or to the settle rule (S8).

L4 (what is unproven). No live host was contacted and no container was started for this change:
the transient reads, the stall bound and the interval are driven by an injected `sleep`, an
injected `Date.now` and an injected interval length, not by wall time or by a real 502. So the
shapes exercised are the ones the code branches on, not a measured sample from the proxy or the
ingest host. The 90 s bound in particular is proven as arithmetic over the loop (the injected
clock reaches exactly the stall window) rather than as 90 seconds of observed behaviour.

L5 (delivery: three work-unit slices, and the one that is over the size guide). `32aadee`
carries the loop (S2-S4) with its tests, 509 changed lines raw and 494 with `git diff -w` —
over the ~400 guide, and deliberately not split: about 350 of those lines are the tests and
their reasoning (`use-ingest.test.tsx`, `api.test.ts`), and a second slice would have
separated a rule from the test that proves it, which is the one split this project's
convention forbids. `a3d2ab4` carries the interval (S5), 225 lines; `48109dc` carries the
re-attach (S6-S7), 229 lines; this commit carries the record — the README section, the
census line and this document. 963 changed lines in total for four behaviours, of which
under a third is production code.

L6 (surfaces touched outside the brief, and why). `web/src/lib/api.ts` and
`web/src/lib/api.test.ts` were granted by the requester after a boundary question, because
`ApiClient.pollIngestJob` rebuilds the loop's options field by field: a field it does not
forward is a fact the hook cannot see, and without it S2's reconnecting notice could only
have been guessed from a timer — invented state on the exact surface whose rule is not to
invent state. The added lines are the optional `onTransient` in that options type, its
forwarding spread, and its type import; `api.test.ts` proves it in both directions
(forwarded: the loop calls it and keeps polling; omitted: the same snapshots and the same
outcome, with the `404`/`503` guards unchanged). One more file moved by a single line:
`web/src/components/ingest-panel-controls.test.tsx` gained `setListLive: () => {}` in its
`UseIngestResult` double, which is a compile fix for the new required member of that type
and not a behaviour change. No other file was touched.
