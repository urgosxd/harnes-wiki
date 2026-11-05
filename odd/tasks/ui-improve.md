# Feature: ui-improve

Three chat-UI defects reported by the human: tool activity names a generic phrase instead of the tool actually running, assistant answers are shown as raw markdown source instead of formatted content, and the transcript viewport is dragged along while tokens stream.
Status: complete
Branch: `feat/tool-ui-streaming`
Created: 2026-11-05
Note: the human calls this feature `feat/ui-improve`; it runs on `feat/tool-ui-streaming` because the `feat/ui-improve` worktree is wedged by an orphan process. Do not rename branches.

## Specs

S1. The requester's first clause, verbatim:

> "que la ui de tools indique correcatemnte que tools se estan ejecutando , no un texto generico usando tools"

Current behavior (evidence, not a requirement): `web/src/components/ActivityList.tsx:33` renders the literal `"Working…"` only when no activity arrived; once a tool starts, the line shown is `toolLabel(tool)`, a static lookup in `server/src/pi/activity.ts` (`read` -> "Reading a document", `bash` -> "Running a command", `grep` -> "Searching the workspace", unknown -> `"Using a tool"` at `activity.ts:42`). The real tool name reaches the browser — `web/src/lib/sse.ts:77` frame `{ type: "tool_started"; tool; label }` — but `web/src/lib/chat-reducer.ts:143` keeps `tool` only inside the React key and `ActivityItem` (`chat-reducer.ts:7-15`) never exposes it. No frame, action, or state field carries tool arguments or a target.

S2. The requester's second clause, verbatim:

> "renderizar respuetsas en buen formato como en chatgpt no markdown puro"

Current behavior (evidence, not a requirement): `web/src/components/MessageList.tsx:32` renders `<div className="message__text">{message.text}</div>` as plain text with `web/src/styles.css:233` `white-space: pre-wrap`; no markdown renderer is present anywhere in the repo and no markdown dependency is installed.

S3. The requester's third clause, verbatim:

> "Permitir que se haga scroll y no haga shift cuando se esta stremeando la respuesta"

Current behavior (evidence, not a requirement): `web/src/components/MessageList.tsx:21-26` runs `endRef.current?.scrollIntoView?.({ block: "end" })` on every `state.streamingText` change with only `if (!streaming) return;` as a guard, so the viewport is forced to the end even when the reader scrolled up. The scroll container is `.chat__scroll` (`web/src/components/ChatWindow.tsx:63`, CSS `web/src/styles.css:185-190`). No "user is pinned to the bottom" detection exists.

## Tasks

| ID | Task | Spec | Route | Commit |
| --- | --- | --- | --- | --- |
| T0 | Feature document and scope record | S1-S3 | gentle-ai-worker | `ac95800` |
| T1 | Name the tool that is actually running in the activity list | S1 | gentle-ai-worker | `7c711b9` |
| T2 | Render assistant answers as formatted rich content | S2 | gentle-ai-worker | `4a07817`, `206ed24`, `d9ecddf` |
| T3 | Keep the transcript scrollable and stop the streaming viewport shift | S3 | gentle-ai-worker | `14833c9`, `8cf6515`, `163314e` |

Routes: every source write goes through `gentle-ai-worker`; independent verification goes to `gentle-ai-verify`, never to the agent that wrote the change. Test-first is mandatory where a runnable deterministic test applies (`web/` has vitest 4.0.6 + jsdom + @testing-library/react 16.3.0).

## Log

L1 (requester's original request, verbatim):

> "Project 1: feat/ui-improve
> Necesito que la ui de tools indique correcatemnte que tools se estan ejecutando , no un texto generico usando tools, y renderizar respuetsas en buen formato como en chatgpt no markdown puro, Permitir que se haga scroll y no haga shift cuando se esta stremeando la respuesta."

L2 (delivery decisions, from the supervising Manager):
> - Installs approved with constraints: `npm ci` in `web/` and `server/` when a lockfile exists (no lockfile mutation); fall back to `npm install` only with no lockfile and say so; never commit `node_modules`; a lockfile change ships in the same commit as its `package.json` change; no `npm publish`, no CI config change, no unrequested version bump. A baseline suite result is required BEFORE the first change.
> - T2/S2 is HELD: adding runtime dependencies is a delivery decision owned by the human, raised by the Manager. Do not pre-install deps and do not scaffold a renderer on a guess. T0, T1 and T3 proceed.
> - S1 fallback approved: if the agent SDK's tool-start event carries no arguments, render the real tool name beside the existing human-readable `toolLabel` line and report the target/key-argument half as UNAVAILABLE. Never invent a target.
> - The SSE payload shape at `web/src/lib/sse.ts:77` is a shared contract with a sibling branch in flight: additive frontend state is allowed, a wire-format change requires Manager approval first.
> - Engram mirror `odd/ui-improve/tasks` is UNAVAILABLE: no `mem_*` tools are callable in this session. The local document is the only tracker.

L3 (exploration evidence, read-only, HEAD 5bf6ebe, clean tree): the `path:line` references quoted under each S# above were verified in this worktree; `web/node_modules` and `server/node_modules` were absent, so no test or typecheck result existed before this feature started.

L4 (T0b): landing this document turned the server suite RED. The census test at `server/test/feature-doc.test.ts:125` (assertion at `:154`) pins the set of documents carrying a task-row table, and it pinned that set to exactly one; with this document present it reported `['multitenant-stackId.md', 'ui-improve.md']` against an expected `['multitenant-stackId.md']`. What the guard protects is that a new task-table SHAPE cannot slip in unread — not that only one document is ever allowed to carry task rows. So the guard was RESTATED to a declared set, `["multitenant-stackId.md", "ui-improve.md"]` (sorted, so readdir order cannot flake the comparison), with the reasoning comment above it restated from "exactly one document has one (29 rows)" to "exactly two (33 rows and 4 rows)". The test was not deleted, skipped, or widened to "any number is fine", and the shape check is unchanged: a task-shaped header that is not five columns still fails at `server/test/feature-doc.test.ts:146-152`. T0's commit cell reads `see L4` because this document landed in that commit.

L5 (supersedes S21's count clause, by declaration):

`multitenant-stackId.md` S21 states that the guard evaluates exactly one table and that "a second document starts carrying task rows" fails the census sentinel. the census test `every task-shaped table is evaluated, so a new shape cannot slip in unread` in `server/test/feature-doc.test.ts` now asserts a DECLARED set of two documents instead. Following this repository's own convention — `multitenant-stackId.md`'s `## Supersedes (do not rewrite history)` section, which amended `pi-chat-mvp.md` by declaration rather than by editing it — S21's count clause is superseded here and that document is left untouched. What survives unchanged is the protection itself: a task-shaped header that is not five columns still fails, and an UNDECLARED document that starts carrying task rows still fails because the declared set is compared exactly.

L6 (S1 delivered as the tool identifier; the target half is a separate future feature):

S1 is delivered as the real tool identifier rendered beside the existing `toolLabel` sentence (`7c711b9`). The "key argument/target" enrichment is NOT delivered and is not a task of this feature. It is technically reachable — the installed `@earendil-works/pi-agent-core` 1.4.0 declares `tool_execution_start` with `args: any` — but it needs `TurnHooks.onToolStart` widened (`server/src/pi/session-factory.ts:48,161-166`), a per-tool allowlist over model-controlled arguments (for `write`/`edit` that payload is whole file bodies, for `bash` it can carry credentials), and an optional `target` field on the `tool_started` frame this branch shares with `feat/urlparam-stackId`. The delivery owner ruled it out of this feature as Risk item 2 and it is recorded as a separate future feature. The S1 quote above is left exactly as the requester wrote it: the Log records the scope decision, the Spec stays the source of truth.

L7 (S2 dependency decision, made by the delivery owner):

Option (a): `react-markdown` 10.1.0 and `remark-gfm` 4.0.1 as runtime dependencies of `web/`, shipped in the same commit as the component that needs them (`4a07817`), with no syntax highlighter, no `rehype-raw`, no `allowDangerousHtml` and no `dangerouslySetInnerHTML` anywhere in `web/src`. `npm audit` reports 3 vulnerabilities in the web tree; `npm ci` on the untouched lockfile reported the same 3 (1 moderate, 1 high, 1 critical) before any dependency of this feature existed, so they are pre-existing and were not audited here. `white-space: pre-wrap` was kept rather than removed: a soft break survives as a newline inside the paragraph text node, so today's line breaks are preserved, and `pre code` sets `white-space: pre` so code blocks never depend on the inherited value.

L8 (S3, the blocker the tests could not see, and its fix):

The writer's suite was green while the requirement was half met. Re-pinning on `messageCount` meant the `finished` transition — the draft moving into the transcript — grew the count 1→2 and pulled a scrolled-up reader to the bottom at the exact moment the answer completed. The independent pass reproduced it (`finished` → 1 `scrollIntoView` call from `scrollTop` 200), and `163314e` fixes it by triggering on `sentCount`, user-role messages plus one while `pendingUserText` is set: it grows on `send` and is unchanged when a turn is committed, so completion cannot move the reader while a second turn still re-pins. `8cf6515` pins the listener lifecycle (unmount removes the same function reference; a swapped container re-attaches). `scroll-hold.test.tsx` now pins hold-on-finish and re-pin-on-send as two separate rules, and the old re-pin case was rewritten because its setup was a state the reducer cannot reach.

L9 (independent verification, run by `gentle-ai-verify` on code it did not write):

Verdicts at HEAD `d9ecddf`: S1 SATISFIED, S2 SATISFIED, S3 SATISFIED after `163314e`. Commands and results: `cd web && npx vitest run` 14 files / 212 tests, exit 0; `cd web && npm run typecheck` exit 0; `cd web && npm run build` exit 0 (296 modules); `cd server && npm test` 237 tests, 194 pass, 0 fail, 43 skipped; `cd server && npm run typecheck` exit 0. The wire surface is untouched: `git diff --stat 5bf6ebe..HEAD -- web/src/lib/sse.ts server/src` is empty, so no sibling branch shares a contract change from this feature. The pass added two locks the suite was missing (`data:` link targets and `<iframe>` were already inert but unprobed, `d9ecddf`). UNVERIFIABLE in this harness: real-browser layout — the caret's actual line and paragraph spacing are asserted structurally only, because jsdom has no layout engine; a human should eyeball the streaming view in a browser. Accepted unfixed, both advisory: a pinned reader does not follow non-text growth (an activity row or the error banner appearing) until the next token, and a DOM node swapped behind the *same* ref object would keep its listener, which no wiring in this app does.

L10 (delivery state for the owner):

The branch carries 42 commits and roughly 5.6k authored lines since `main`, far past the ~400-line work-unit slice; the reviewable boundary is per commit in the Tasks table, not per branch. `odd/tasks/multitenant-stackId.md` S21's count clause is superseded by declaration in L5 and that document was not edited. `.tmp/` is NOT in `.gitignore`, so the instructed gitignored scratch location does not exist; the verifiers wrote nothing rather than create it. Scratch left outside the project root by agents of this feature — not deleted, because deleting outside the root is not authorized: `/tmp/verify-baseline-VDYV4b`, `/tmp/srv-2407971.log`, `/tmp/gpNItgaj/tmp.rPACrT272z`, `/tmp/gpNItgaj/tmp.wg44HgEvaY`, `/tmp/gpNItgaj/tmp.IiLhqPyh2V`.
