# feat/urlparam-stackId — the URL's stackId as default, an explicit choice as override

Scope: the stackId resolution order for tool calls, and the ingest form's stackId prefill plus selection.
Branch: feat/urlparam-stackId.

## Specs

S1. Tool calls use the stackId in the URL by default, and an explicitly indicated one wins over it:
"cuando se llamen la tools se debera usar por default o fallback el parameter URL ahi esta el stackId, si el usuario inidaca que se use otro se usara, pero como fallback simpero el de la url"

S2. Ingest prefills the same URL-derived stackId as its fallback:
"Ademas de tambien llenar por default en ingest ,como fallback , el mismo caso"

S3. Ingest lets the user choose the stackId it submits:
"y que tambien se pueda elegir el stackId para hacer ingest"

S4. When the stackId is resolvable from neither source, the surface says so instead of using an empty or undefined stackId:
"if the stackId cannot be resolved from either source, surface a clear error rather than silently using an empty/undefined stackId"

## Tasks

| ID | Task | Spec | Route | Commit |
| --- | --- | --- | --- | --- |
| T1 | Explicit tool argument wins over the turn's URL-derived stackId; the URL stays the only fallback; a clear error when neither exists | S1, S4 | worker | 1b1514e |
| T2 | Read-only `GET /stacks` exposing the known stack ids | S3 | worker | 0b05b18 |
| T3 | `listStackIds` client method and useIngest effective stackId (selection wins, URL is fallback, notice when neither) | S2, S3, S4 | worker | a2211a4 (with T4) |
| T4 | Ingest stackId selector preselected from the URL, submitting the chosen value | S3, S4 | worker | a2211a4 (with T3) |
| T5 | Docs and help copy for the new order and the selection | S1-S4 | worker | 20f2a88 |
| T6 | The divergent Stack is visible in the turn's output, not only in the log | S1 | worker | 01180f1 (with ecaa446) |

## Log

L1 (user, verbatim):
"Procjet 2: feat/urlparam-stackId
cuando se llamen la tools se debera usar por default o fallback el parameter URL ahi esta el stackId, si el usuario inidaca que se use otro se usara, pero como fallback simpero el de la url, Ademas de tambien llenar por default en ingest ,como fallback , el mismo caso y que tambien se pueda elegir el stackId para hacer ingest"

L2 (Manager, derived scope, verbatim):
1. Resolution order for stackId in tool calls must be: explicit user-supplied stackId (tool argument) if provided, otherwise fall back to the stackId present in the current URL/page context. The URL value is always the fallback.
2. Ingest must prefill the stackId field by default with the same URL-derived value (fallback behavior identical to tool calls).
3. The user must be able to choose a different stackId for ingest (a selectable control listing available stackIds, with the URL-derived one preselected), and ingest must submit the chosen one.
Also: if the stackId cannot be resolved from either source, surface a clear error rather than silently using an empty/undefined stackId.

L3 (Lead, reconnaissance evidence):
- URL to tool calls today: `web/src/lib/tenant.ts:47 parseStackId` → `web/src/App.tsx:32-34` → `x-stack-id` header (`web/src/App.tsx:104`) → `server/src/api/routes.ts:147 withStackContext` → `server/src/pi/tenant-runtime.ts:335 resolveStackArgument`.
- S1 gap: `server/src/pi/tenant-runtime.ts:363-371` errors instead of honoring a differing explicit `stackId` tool argument.
- S2/S3 gap: `web/src/lib/use-ingest.ts:198-200` spreads the URL-valued `stackId` after the caller's options, discarding any selection; `web/src/lib/api.ts:201,255` already send `stackId` in the ingest body.
- No stack list reaches the UI: `server/src/api/ingest-routes.ts:224` uses `c.listStackIds()` internally only.
- Ingest contract already accepts an optional body `stackId` and rejects unknown ids with `400 unknown_stack` (`server/src/api/ingest-routes.ts:102-105,223-234`).

L4 (Lead, decision): S1 supersedes the conflict-error rule of `odd/tasks/multitenant-stackId.md` (S10). The URL remains the only fallback, never a remembered or defaulted value. Confirmed by the Manager in L5 (decision D1): T1 stands as implemented and is not reverted.

L5 (Manager, decision D1, verbatim): "D1 APPROVED as you stated it. Your reading matches the human's verbatim requirement ("si el usuario indica que se use otro se usará, pero como fallback siempre el de la URL"), so the explicit tool argument wins and the URL-derived stack is the only fallback. Do not drop T1." Binding conditions: T1 keeps its own commit and an independent verification by an Agent that did not implement it; S10 is superseded append-only so its original text stays legible; the override is non-silent on the server through one structured log line naming the turn's URL-derived stack and the argument's stack, with no new UI; failure modes stay as today (unknown Stack still `400 unknown_stack`; when neither source resolves a stack, a clear error and no silent empty value); the ingest request body contract is unchanged and `GET /stacks` stays purely additive and read-only.

L6 (Lead, T5 documentation): the README now states the tool-call order the code applies, not the request — an explicit `stackId` argument wins, the turn's link Stack is the fallback, and with neither the call is refused before anything reaches the upstream (`server/src/pi/tenant-runtime.ts:344-385`); a call that overrides the turn's Stack is forwarded and recorded in one structured log line naming the tool, the turn's Stack and the argument's Stack (`:359-366`), which supersedes the refusal rule the README used to describe. The ingest section now says reads stay the link's Stack, writes take the chosen Stack with the link as fallback (`web/src/lib/use-ingest.ts:103-108,243`), documents the new read-only `GET /stacks` (`200 {"stackIds": string[]}`, `{"stackIds": []}` when the service lists none, `server/src/api/ingest-routes.ts:313-330`) in the API table and in place, quotes `UNRESOLVED_STACK_ID_NOTICE` verbatim for the unresolved case (`web/src/lib/use-ingest.ts:76-78`), and states two known limitations: the Recent list stays scoped to the link's Stack, so a job started in a chosen Stack is not listed there, and a failed `GET /stacks` degrades silently to the link's value instead of blocking the write path.

L7 (independent Agent verification of 1b1514e, accepted): an Agent that did not implement T1 verified commit `1b1514e` independently and ACCEPTED the guard inversion (an explicit tool argument wins, the link's Stack is the fallback, refusal when neither names a Stack). Its findings: one required fix — `server/src/pi/stack-context.ts:29-30` still claimed the request's Stack "is never logged" and "travels without being written down anywhere", which the override record added by `1b1514e` (`server/src/pi/tenant-runtime.ts:358-364`, `tool call overrides the turn's Stack`, carrying `turnStackId` and `argumentStackId`) made false; that comment now states the single exception and was corrected in a comment-only commit. Two advisories were left deliberately untouched: (a) a non-string `stackId` with no turn Stack receives the "open the app with a link" advice rather than the type message — the pre-existing check order, fail-closed either way; (b) only a top-level `args.stackId` is inspected, so a `stackId` nested in a tool's own filter object would not be logged (no provisioned tool declares a nested one today). Also noted, and left alone: a pre-existing weak assertion at `server/test/stack-scope-gate.test.ts:109-113` that only checks `isError !== true`.

L8 (requester decision, verbatim, and its consequences — this supersedes L5's "with no new UI" and completes L7's remaining objection): "the model's explicit `stackId` argument keeps winning, BUT the divergence must be VISIBLE in the product, not only in a server log." The reason, accepted by the requester from an external reviewer: the refusal that `1b1514e` removed was the only thing that told a human "a foreign Stack was used here", and a log line nobody reads does not replace it — so the person using the product must be able to SEE the divergence in that turn's output.

L8 evidence (T6, commits `01180f1` and `ecaa446`):
- Where a human actually sees it. The chat renders the assistant's text and the activity labels; a tool's RESULT text never reaches the browser — `tool_result` frames are handed to `useChat`'s `onToolResult` (`web/src/lib/use-chat.ts:151`) and nothing in the app passes that callback. Preferring the tool result was therefore not an option that a person could read, so the notice rides the frame that already closes a tool call (`tool_finished`, new optional `notice` field) and is rendered in `ChatWindow` as its own line.
- Server: `resolveStackArgument` returns the sentence it already knew (`server/src/pi/tenant-runtime.ts:367-382`), the proxy attaches it to the tool result's `details`, never to its content (`:323-330`), `stackNoticeFromResult` lifts it out of the finished call (`server/src/pi/session-factory.ts:240-259`), and `toolFinishedFrame` puts it on the frame with the label unchanged (`server/src/api/turn-service.ts:173-181`). The structured log record is kept: one `tool call overrides the turn's Stack` per overridden call.
- Wording: `Ran on Stack B, not the session's Stack A.` and, when the turn had no Stack of its own, `Ran on Stack B; the session had no Stack.` — naming a session Stack there would describe a request that never happened.
- Client: `stackNotices` in `web/src/lib/chat-reducer.ts:35-44` survives the `loaded` reload that ends a turn (that reload is what would otherwise make the line as invisible as the log) and is cleared by the next `send` or by switching conversations. Shown in `web/src/components/ChatWindow.tsx:80-84`. `ActivityList.tsx`, `MessageList.tsx` and `Markdown.tsx` were not touched: the notice is not an activity row and not assistant prose.
- Tests, written first and observed RED: `server/test/stack-notice.test.ts` (9 cases) and `web/src/stack-notice.test.tsx` (7 cases), both asserting the sentence appears AND that it does not appear for the agreeing argument or the absent one.
- Pinned, not accidental: with an AMBIGUOUS `x-stack-id` (duplicate header, or a comma-joined value) `requestStackId` answers "no Stack" (`server/src/api/routes.ts:34-44`), so a request can reach `resolveStackArgument` with no turn Stack at all. Because the explicit-argument return at `server/src/pi/tenant-runtime.ts:367-382` precedes the "no link Stack" refusal at `:385-392`, such a call is FORWARDED to the argument's Stack rather than refused — a behaviour change introduced by `1b1514e` that nobody asked for in those words. It is defensible under S1 (the argument is a source) and it is now pinned at the observable level: the same path emits the `the session had no Stack` notice (`server/test/stack-notice.test.ts`, "with no session Stack, the notice says so instead of claiming one"), and `server/test/stack-context.test.ts:216` already pinned the forwarding.
- Left alone on purpose, per instruction: the weak assertion at `server/test/stack-scope-gate.test.ts:109-113` (`isError !== true` only, which no longer discriminates after `1b1514e`). Recorded here so it is not mistaken for a passing verification of the "S10 same" rule.

L8 risk: item 2 (security). The guard's direction is unchanged — a tool call can still read a Stack other than the one the link selected — and this commit only makes that divergence visible; a screen line is not an authorisation, and the structured log record remains the audit trail.

L9 (implementer, F5 of the independent verification — the attribution race; web only): the notice is now stamped with the conversation whose turn produced it.
- The gap: `openConversation` aborts the previous stream and `reset`s the state (`web/src/lib/use-chat.ts:58-74`), while `send`'s frame loop is not guarded by run or conversation id; `loaded` now keeps notices (L8), so a frame still draining from conversation A could paint its sentence in conversation B — a claim about a turn that never happened there. The same shape pre-exists on `delta`/`activity` and is left untouched, as instructed.
- The change: `stack_notice` carries the run's `conversationId` (`web/src/lib/use-chat.ts:143-151`), `ChatState.stackNotices` holds `{ conversationId, text }` stamps and dedupes per conversation (`web/src/lib/chat-reducer.ts:44-63,203-215`), and the window paints only the notices of the thread it is showing, through `stackNoticesFor(state, conversationId)` fed with `useChat`'s `activeId` — the same value the thread was loaded with (`web/src/lib/chat-reducer.ts:271-287`, `web/src/components/ChatWindow.tsx:6-15,88-96`, `web/src/App.tsx:185-188`).
- Tests, written first and observed RED in `web/src/stack-notice.test.tsx`: the reducer keeps A's notice out of B's thread and shows it in A's; `ChatWindow` paints it for `conv-a` and nothing for `conv-b`; and an App-level test whose stub keeps A's stream open after the user opens B — before the change the sentence WAS painted there (`AssertionError: expected <p class="chat__stack-notice" …(1)></p> to be null`), after it nothing is, while a neighbouring unstamped frame (the activity row) still proves the frame really arrived.

L10 (implementer, F4 of the independent verification — attribution of the sentence; server and web): the sentence now names the tool, and the client keys its dedupe on the tool as well as the sentence.
- The gap: the sentence named no call and the client deduped by exact string, so two divergent calls to the SAME foreign Stack collapsed into one line that named no call at all — a reader could not tell whether one call or five had left the session's Stack.
- The change: `stackNotice` takes the tool name (`server/src/pi/tenant-runtime.ts:424-432`), so a divergent call reads `<tool> ran on Stack <B>, not the session's Stack <A>.` and, with no session Stack, `<tool> ran on Stack <B>; the session had no Stack.` The client stamp carries the tool and dedupes on (conversation, tool, sentence) (`web/src/lib/chat-reducer.ts:65-78,208-228`, `web/src/lib/use-chat.ts:143-155`), one line per divergent call, and the README table of the two sentences was corrected in the same commit (`README.md:736-746`).
- Supersedes the WORDING bullet of L8 only. L8's rule is untouched: the surface is the same, one sentence per divergent call, the no-session-Stack variant is kept, the log record is kept, and nothing claims a session Stack that did not exist.
- Tests, written first and observed RED in `server/test/stack-notice.test.ts`: the two wording cases failed against the old sentence (`expected: "ingest_jobs_list ran on Stack stack-b, not the session's Stack stack-a."` / `actual: "Ran on Stack stack-b, not the session's Stack stack-a."`), and a new case pins two tools diverging to the same foreign Stack as two attributed sentences. On the client side `web/src/stack-notice.test.tsx` pins the tool-carrying stamp, keeps two different tools to one foreign Stack apart, and tests the dedupe KEY itself (same sentence, two tools) so a future rewording cannot silently merge two calls again.
