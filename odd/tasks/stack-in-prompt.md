# Feature: stack-in-prompt

The session's Stack currently reaches the agent only as a per-call tool argument. The model
never learns its value, so a question like "ingest this into my stack" is answered by asking
which Stack, or by picking one from `list_stacks`. This feature puts the link's Stack into the
system prompt of the turn, without persisting it and without changing who wins a divergence.

Status: complete
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
| T1 | RED test proving the provider's system prompt carries the turn's Stack, then implement the section and wire it into the runtime; README updated with it | S1-S8 | worker | `3cea3a1` |
| T2 | Verification: focused test, full server suite, typecheck, web suite | S1-S8 | inline | `3cea3a1` |
| T3 | Work-unit commit on `feature/stack-in-prompt` | S1-S8 | inline | `3cea3a1` |

## Log

L1 (verbatim, the request):

> "lo que quiero es que cuando abra el agente web y lo abra con el stakc en el url, al preguntar en el chat ya sepa que estoy refiriendome a ese stack y no a otro"

L2 (decision: carrier). The Stack reaches the model as a FORCED PROMPT, not as a user
message and not as a tool description. A `before_agent_start` result `systemPrompt` is
projected as the leading system message of the provider request and is not recorded
(`agent-session.js` `_installAgentForcedPromptProjection`), which is the only carrier that
satisfies S2 and S3 at once: the model reads it before choosing a tool, the user's own text
is never rewritten, and no new value is stored. Rejected: prepending to `session.prompt()`
(persists the section into the transcript and shows it in the chat) and reloading the
`DefaultResourceLoader` per turn (re-discovers resources and races between concurrent turns
of the same user).

L3 (decision: tag). The section is wrapped in `<session_stack>`. The SDK wraps every named
section in a tag of its own name (`buildSystemPromptSections`), and a bare paragraph appended
to an already-rendered prompt would read as a continuation of the last section.

L4 (evidence). RED: the provider request carried no Stack, and all four tests failed on that
assertion (`server/test/stack-prompt.test.ts`). GREEN after the wiring: 4/4. Suite: server
293 tests, 250 pass, 0 fail, 43 skipped (pre-existing Postgres/credential gates; the new file
skips nothing); server typecheck clean; web typecheck clean and 246/246 green after restoring
an incomplete `web/node_modules` (`react-markdown` and `remark-gfm` were declared and absent,
which failed 9 web files before this branch touched anything — `web/` has no changes here).

L5 (gap, disclosed not papered). The test observes the `TranscriptContext` handed to the
provider API implementation, i.e. after Pi's own projection, not a serialized HTTP body. Same
object the production provider code receives; the difference is only serialization.

L6 (delegation). T1 was delegated to `agentdocumentor-dev` under the label `stack-in-prompt`;
its own subagents are read-only, so the implementation ran inside that agent rather than in a
nested writer.
