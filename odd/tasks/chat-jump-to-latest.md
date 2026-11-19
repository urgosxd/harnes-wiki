# Feature: chat-jump-to-latest

Two ways to reach the end of a conversation: one when it is opened, one while it is being
read. Long histories are the case both exist for.
Status: in progress
Branch: feat/chat-jump-to-latest
Created: 2026-11-18
Requester: the repo owner

## Specs

S1 (requester's original request, verbatim):

> "Ahora agrega en cada conversacion ir al ultmo mensaje me demoro escroleando"

S2. Opening a conversation shows the LAST message without any manual scrolling — on first
paint, and again every time a different conversation is selected. No animation that would
make a long jump feel like a slide.

S3. While the view is not at the bottom, a control is available to jump to the last message.
It is reachable by keyboard, has a name a screen reader can announce, and its label says
what it does (not just an arrow).

S4. The control is not shown when the view IS at the bottom — a permanent button that does
nothing is noise.

S5. Content arriving while the reader is scrolled up (a streaming answer, a new message) must
NOT move the viewport; instead the control indicates that there is something new below.

S6. While the reader IS at the bottom, arriving content keeps following the way it does
today — do not regress the existing auto-follow during streaming.

S7. No other chat behaviour changes: sending a message, the empty state, the composer, the
sidebar, and the existing `role_notice`/stack-notice rendering stay as they are.

## Tasks

| ID | Task | Spec | Route | Commit |
| --- | --- | --- | --- | --- |
| T0 | Feature document and the census line it needs | S1-S7 | inline | pending |
| T1 | Jump to the last message when a conversation opens, per conversation | S2 | inline | pending |
| T2 | A jump control while scrolled up, hidden while at the bottom | S3-S4 | inline | pending |
| T3 | Arriving content marks news for a scrolled-up reader and keeps following for a pinned one | S5-S6 | inline | pending |
| T4 | Nothing else in the chat surface changes | S7 | inline | pending |

## Log

L1 (requester's original request, verbatim):

> "Ahora agrega en cada conversacion ir al ultmo mensaje me demoro escroleando"

L2 (why both problems are in scope): the sentence names one complaint — "I take ages
scrolling" — and the chat surface has two ways to produce it. Opening a conversation leaves
the reader at the top of its history, so the thing they came for is a scroll away; and while
reading, nothing in the window takes them back to the last message except dragging the
scrollbar through everything. Fixing only the first leaves the second; the control in S3/S4
is useless without a decision about what happens when content arrives while the reader is
away from the bottom, which is why S5/S6 are specs rather than implementation notes. S7
exists because this file's neighbours in `web/src/components` are a working surface: the
composer, the empty state, the sidebar and the Stack/role notices are not part of this
change and must survive it unchanged.

L3 (the jsdom seam, and exactly what it proves): jsdom has no layout engine, so `scrollTop`,
`scrollHeight` and `clientHeight` are all zero and `scrollIntoView` is a no-op installed by
`web/vitest.setup.ts`. A test that renders the chat and asserts "it scrolled" would therefore
prove nothing. So the decision is separated from the browser's scrolling:

- "Is the view at the bottom" is computed by `isPinnedToBottom` (`web/src/lib/stick-to-bottom.ts`),
  a pure function over the three numbers a container reports, with a 24px tolerance
  (`DEFAULT_PIN_THRESHOLD`). The tests lend the real `.chat__scroll` element those three
  numbers with `Object.defineProperty` and drive a position change with `fireEvent.scroll`,
  which is the same event a browser fires. **Proven by the seam:** given these numbers, the
  control is shown or hidden; given this click, the jump was requested; given content
  arriving while scrolled up, no jump was requested and the news marker appeared.
- The jump itself is requested through `element.scrollIntoView({ block: "end" })`, the one DOM
  call that can move a viewport, stubbed with `vi.fn()` so a request is countable. **Proven by
  the seam:** that the component asked for the jump, with no `behavior: "smooth"` (an
  animated long jump would be the slide S2 forbids).

What that leaves unproven is in L4.

L4 (what a real browser would have to confirm): the seam proves the DECISION and the REQUEST,
never the pixels. A browser has to confirm that (a) a freshly opened long conversation is
actually painted at its end and no top-of-history frame is visible before it lands — the jump
runs in a layout effect, which is the best the code can do and is still one paint order the
test cannot observe; (b) `scrollIntoView({ block: "end" })` moves this particular nested
scroll container (`.chat__scroll` inside `.app`) rather than an ancestor; (c) the 24px
tolerance feels right on a trackpad, including over-scroll past the end, which some browsers
allow and `isPinnedToBottom` counts as pinned; (d) the control's placement above the composer
does not cover the last line of the transcript on a short viewport; (e) the scroll event a
programmatic jump produces re-confirms "at the bottom" in a real event loop, so the control
disappears once the browser has actually moved rather than only because the click said so.
