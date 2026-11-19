import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * How close to the bottom counts as "following the answer", in pixels.
 *
 * A little slack on purpose: a reader who is a handful of pixels from the end
 * still wants the transcript to keep up with it.
 */
export const DEFAULT_PIN_THRESHOLD = 24;

/** The three numbers a scroll container reports about its position. */
export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * Whether the viewport is pinned to the bottom of its content.
 *
 * Pure, so the rule is testable without a layout engine: it only compares the
 * three numbers a container already reports. A gap that is negative (some
 * browsers allow over-scroll past the end) still counts as pinned.
 */
export function isPinnedToBottom(
  metrics: ScrollMetrics,
  threshold: number = DEFAULT_PIN_THRESHOLD,
): boolean {
  const gap = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  return gap <= threshold;
}

export interface StickToBottomOptions {
  /** True while an answer is being streamed into the transcript. */
  streaming: boolean;
  /** Identifies the growing content; streaming follows it when it changes. */
  contentKey: unknown;
  /**
   * How many turns the READER has sent, counting the one still waiting for its
   * reply. It grows only when the reader sends, and never when a turn is
   * committed: ending an answer is not the reader asking to be moved.
   *
   * It deliberately is NOT the transcript length. Appending a finished turn
   * adds a user message and the answer, while the draft that carried the turn
   * disappears, so a length-based trigger fires at the exact moment an answer
   * completes and yanks a reader who had scrolled up to re-read something.
   */
  sentCount: number;
  /**
   * The conversation on screen, or `null` before one exists.
   *
   * A conversation the reader SELECTED is a history they asked to look at, so
   * opening it places the viewport at its end — on the first one as much as on
   * the tenth. Selecting is what makes this different from the transcript
   * merely growing, which must never move a reader who scrolled up.
   */
  conversationId: string | null;
  /**
   * True while that history is still being fetched. There is nothing to land on
   * yet, so the jump waits for the transcript instead of firing into an empty
   * frame and losing it.
   */
  loadingThread: boolean;
}

function scrollToEnd(element: HTMLElement | null): void {
  // Optional call: a document without layout (tests, some embedded webviews) has
  // no scrollIntoView, and a missing scroller must not break the answer.
  element?.scrollIntoView?.({ block: "end" });
}

/**
 * Keeps the transcript following its own bottom, and only then.
 *
 * The viewport belongs to the reader: while an answer streams, the transcript
 * scrolls along only if the reader is already at the bottom. Scrolling up is a
 * deliberate act, so it is respected and never undone by an arriving token, and
 * never undone by the answer ending either. Two things are the reader asking to
 * be moved rather than content arriving, and both re-pin: a message they send,
 * which must not land off-screen, and a conversation they open, which they
 * selected in order to read its end.
 */
export function useStickToBottom(
  container: RefObject<HTMLElement | null>,
  end: RefObject<HTMLElement | null>,
  opts: StickToBottomOptions,
): void {
  const { streaming, contentKey, sentCount, conversationId, loadingThread } = opts;
  // Starts pinned: an open stream begins at the end, as it always did.
  const pinned = useRef(true);
  const previousSent = useRef(sentCount);
  // The conversation the viewport was last placed for. `undefined` means "never
  // placed yet", which is not the same fact as `null`, "no conversation on
  // screen": a reader who starts on a new chat and then opens one must land at
  // that one's end.
  const placedFor = useRef<string | null | undefined>(undefined);

  // The reader's own scrolling is the only thing that changes the decision, so
  // it is read from the container's scroll event and from nothing else.
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const onScroll = () => {
      pinned.current = isPinnedToBottom(element);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [container]);

  // Follow the growing answer, but never fight a reader who scrolled away.
  useEffect(() => {
    if (!streaming || !pinned.current) return;
    scrollToEnd(end.current);
  }, [contentKey, streaming, end]);

  // Opening a conversation lands on its last message, and so does switching to
  // another one: the reader selected that history, they did not arrive at its
  // top, and scrolling a long one by hand is the complaint this exists for.
  //
  // A layout effect, so the move happens before the browser paints the frame:
  // a `useEffect` would show the top of the history first and pull it away.
  // Deliberately only on a change of conversation — keyed on the transcript
  // instead, every arriving message would drag a reader who had scrolled up.
  useLayoutEffect(() => {
    if (loadingThread) return;
    if (placedFor.current === conversationId) return;
    placedFor.current = conversationId;
    if (conversationId === null) return;
    pinned.current = true;
    // The arrival of a stored history also grows `sentCount`: its user turns appear all
    // at once. Placing the viewport here IS the re-pin that growth would ask for, so it
    // is recorded as already handled — one arrival, one request, not two.
    previousSent.current = sentCount;
    scrollToEnd(end.current);
  }, [conversationId, loadingThread, end, sentCount]);

  // A message the reader sent must not land off-screen. Keyed on the reader
  // sending, not on the transcript growing: a finished turn grows the transcript
  // on its own, and moving a reader who scrolled up to read is the bug this
  // guards against.
  useEffect(() => {
    if (sentCount === previousSent.current) return;
    previousSent.current = sentCount;
    pinned.current = true;
    scrollToEnd(end.current);
  }, [sentCount, end]);
}
