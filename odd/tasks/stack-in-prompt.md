# Feature: stack-in-prompt

The session's Stack currently reaches the agent only as a per-call tool argument. The model
never learns its value, so a question like "ingest this into my stack" is answered by asking
which Stack, or by picking one from `list_stacks`. This feature puts the link's Stack into the
system prompt of the turn, without persisting it and without changing who wins a divergence.

Status: in progress
Branch: feature/stack-in-prompt
Created: 2026-11-17
Requester: the repo owner, in the chat session.

## Specs

S1 (verbatim, the request):

> "lo que quiero es que cuando abra el agente web y lo abra con el stakc en el url, al preguntar en el chat ya sepa que estoy refiriendome a ese stack y no a otro"

S2 (carrier — the model reads it, not the tool). The leading system prompt the provider
receives for a turn names the link's Stack. It does not depend on the model calling a tool
first, and it is not a user message: the user's own text is stored and shown exactly as typed.

S3 (same source, per turn, not persisted). The value is `currentStackId()` — the same
per-request context the tool proxy already reads (`server/src/pi/stack-context.ts`). It is
resolved per TURN on that turn's async chain, never from the cached tenant runtime, and it adds
no new stored value: S9 and S11 of `multitenant-stackId.md` keep their exact meaning.

S4 (no Stack, no section). A turn whose link names no Stack gets no Stack section at all. The
existing fail-closed tool error stays the only statement (S9/S13 of `multitenant-stackId.md`),
and the chat keeps opening without a Stack (S13).

S5 (concurrency). Two turns of the same user running at once with different Stacks each see
THEIR OWN value in their own prompt, with no bleed (S12 of `multitenant-stackId.md`).

S6 (routing unchanged). The prompt states the session's Stack as the default; the resolution
order is untouched — an explicit `stackId` argument still wins, and a divergence is still
reported in the turn's output and in the log (`resolveStackArgument`).

S7 (ingest untouched). The ingest surface, its routes and its adapter do not change.

S8 (no false green). The test proves what the MODEL receives, not what our own helper returns.
If the provider request cannot be observed without model credentials, that gap is reported as a
gap — never papered over with a unit test of the composition alone (S22 of
`multitenant-stackId.md`).

## Tasks

| ID | Task | Spec | Route | Commit |
|---|---|---|---|---|
| T1 | RED test proving the provider's system prompt carries the turn's Stack, then implement the section and wire it into the runtime; README updated with it | S1-S8 | worker | pending |
| T2 | Verification: focused test, full server suite, typecheck, web suite | S1-S8 | inline | pending |
| T3 | Work-unit commit on `feature/stack-in-prompt` | S1-S8 | inline | pending |

## Log

L1 (verbatim, the request):

> "lo que quiero es que cuando abra el agente web y lo abra con el stakc en el url, al preguntar en el chat ya sepa que estoy refiriendome a ese stack y no a otro"
