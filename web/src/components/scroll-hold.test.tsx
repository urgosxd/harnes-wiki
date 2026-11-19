import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ChatWindow } from "./ChatWindow.tsx";
import { initialChatState, type ChatState } from "../lib/chat-reducer.ts";

/**
 * jsdom has no layout engine, so a rendered transcript is always 0x0 and
 * scrollIntoView does nothing. These tests lend the chat's scroll container real
 * metrics and stub the one DOM call that can move a viewport, so the behaviour
 * complained about (the viewport being dragged along by streamed tokens) is
 * observable through the public DOM surface only.
 *
 * The scroll decision is made by the component that owns the container —
 * `ChatWindow` — so that is the host here: the rules below are about the window's
 * behaviour, not about how one child happens to be built.
 */
interface Metrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

const handlers = { onSend() {}, onRetry() {}, onStop() {}, onOpenSidebar() {} };

let scrollIntoView: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // vitest.setup.ts installs a no-op; replace it so calls can be counted.
  scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView as unknown as Element["scrollIntoView"];
});

function lendMetrics(element: HTMLElement, metrics: Metrics): void {
  Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => metrics.scrollHeight });
  Object.defineProperty(element, "clientHeight", { configurable: true, get: () => metrics.clientHeight });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => metrics.scrollTop,
    set: (value: number) => {
      metrics.scrollTop = value;
    },
  });
}

function state(overrides: Partial<ChatState> = {}): ChatState {
  return {
    ...initialChatState,
    status: "streaming",
    pendingUserText: "question",
    streamingText: "partial",
    ...overrides,
  };
}

/**
 * One conversation on screen, with its scroll container reporting real geometry:
 * 1000px of content in a 500px viewport, the reader at the bottom (scrollTop 500).
 */
function openChat(initial: ChatState) {
  const conversationId = "conv-1";
  const view = render(
    <ChatWindow
      state={initial}
      conversationId={conversationId}
      loadingThread={false}
      {...handlers}
    />,
  );
  const scroller = view.container.querySelector(".chat__scroll");
  if (!(scroller instanceof HTMLElement)) throw new Error("the chat has no scroll container");
  const metrics: Metrics = { scrollTop: 500, scrollHeight: 1000, clientHeight: 500 };
  lendMetrics(scroller, metrics);

  return {
    rerender: (next: ChatState) =>
      view.rerender(
        <ChatWindow
          state={next}
          conversationId={conversationId}
          loadingThread={false}
          {...handlers}
        />,
      ),
    scroller,
    metrics,
  };
}

describe("MessageList scroll holding", () => {
  it("follows the answer while the reader is pinned to the bottom", () => {
    const container = openChat(state());
    // The existing behaviour is kept: an open stream starts at the end, and it now asks
    // for that twice — exactly twice. Opening the conversation places the viewport on its
    // last message (the placement layout effect, S2), and the stream that is already
    // running follows it there (S6). The scenario is deterministic, so the count is
    // pinned instead of "the end was requested": one mount, one conversation, no timers,
    // no frames arriving mid-test, and the two state writes the placement makes are both
    // no-ops on the state they would set. A third request, or a missing one, is a change
    // of behaviour and must fail here rather than pass as "something scrolled".
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    // Both requests carry the same argument, so the argument pins what each asks for —
    // the end, with no `behavior: "smooth"` (the slide S2 forbids) — and the two
    // `toHaveBeenNthCalledWith` calls fix which request is which: the open jump first,
    // the follow second.
    expect(scrollIntoView).toHaveBeenNthCalledWith(1, { block: "end" });
    expect(scrollIntoView).toHaveBeenNthCalledWith(2, { block: "end" });

    scrollIntoView.mockClear();
    container.rerender(state({ streamingText: "partial answer" }));

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("holds the reader's position when they scrolled away from the streaming answer", () => {
    const container = openChat(state());

    // The reader scrolls up to read: 300px of content is now below the viewport.
    container.metrics.scrollTop = 200;
    fireEvent.scroll(container.scroller);
    scrollIntoView.mockClear();

    container.rerender(state({ streamingText: "partial answer grows" }));

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(container.metrics.scrollTop).toBe(200);
  });

  it("holds a scrolled-up reader when the answer finishes", () => {
    const user = { id: "u1", role: "user" as const, text: "question" };
    const container = openChat(state({ messages: [user], pendingUserText: null, streamingText: "the answer" }));
    container.metrics.scrollTop = 200;
    fireEvent.scroll(container.scroller);
    scrollIntoView.mockClear();
    container.rerender(
      state({
        messages: [user, { id: "a1", role: "assistant", text: "the answer" }],
        pendingUserText: null,
        streamingText: "",
        status: "idle",
      }),
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(container.metrics.scrollTop).toBe(200);
  });

  it("re-pins to the end when a new message arrives", () => {
    // The transcript of an earlier turn: the reader's question and its answer,
    // and no draft left over, which is the state the reducer settles on after a
    // turn finishes.
    const earlierQuestion = { id: "m0", role: "user" as const, text: "earlier question" };
    const firstMessage = { id: "m1", role: "assistant" as const, text: "earlier answer" };
    const transcript = [earlierQuestion, firstMessage];
    const container = openChat(
      state({
        messages: transcript,
        pendingUserText: null,
        streamingText: "streaming from the top",
      }),
    );

    // The reader scrolls up while the next answer streams in.
    container.metrics.scrollTop = 200;
    fireEvent.scroll(container.scroller);
    scrollIntoView.mockClear();

    // The reader sends a new message: its draft bubble appears, which is the
    // only thing `send` does to the transcript. It must never end up off-screen.
    container.rerender(
      state({
        messages: transcript,
        pendingUserText: "a new question",
        streamingText: "streaming from the top",
      }),
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    // And the reader is pinned again, so the next token keeps following.
    scrollIntoView.mockClear();
    container.rerender(
      state({
        messages: transcript,
        pendingUserText: "a new question",
        streamingText: "streaming from the top, one token later",
      }),
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
