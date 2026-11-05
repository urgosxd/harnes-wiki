import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { RefObject } from "react";
import { MessageList } from "./MessageList.tsx";
import { initialChatState, type ChatState } from "../lib/chat-reducer.ts";

/**
 * jsdom has no layout engine, so a rendered transcript is always 0x0 and
 * scrollIntoView does nothing. These tests lend the scroll container real
 * metrics and stub the one DOM call that can move a viewport, so the behaviour
 * complained about (the viewport being dragged along by streamed tokens) is
 * observable through the public DOM surface only.
 */
interface Metrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

function scrollContainer(initial: Metrics) {
  const element = document.createElement("div");
  const metrics: Metrics = { ...initial };

  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: () => metrics.scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    get: () => metrics.clientHeight,
  });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => metrics.scrollTop,
    set: (value: number) => {
      metrics.scrollTop = value;
    },
  });

  const ref: RefObject<HTMLElement | null> = { current: element };
  return { ref, element, metrics };
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

let scrollIntoView: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // vitest.setup.ts installs a no-op; replace it so calls can be counted.
  scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView as unknown as Element["scrollIntoView"];
});

describe("MessageList scroll holding", () => {
  it("follows the answer while the reader is pinned to the bottom", () => {
    // Reader at the very bottom: bottom of a 1000px transcript in a 500px view.
    const container = scrollContainer({ scrollTop: 500, scrollHeight: 1000, clientHeight: 500 });

    const { rerender } = render(<MessageList state={state()} scrollRef={container.ref} />);
    // The existing behaviour is kept: an open stream starts at the end.
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    scrollIntoView.mockClear();
    rerender(<MessageList state={state({ streamingText: "partial answer" })} scrollRef={container.ref} />);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("holds the reader's position when they scrolled away from the streaming answer", () => {
    const container = scrollContainer({ scrollTop: 500, scrollHeight: 1000, clientHeight: 500 });

    const { rerender } = render(<MessageList state={state()} scrollRef={container.ref} />);

    // The reader scrolls up to read: 300px of content is now below the viewport.
    container.metrics.scrollTop = 200;
    fireEvent.scroll(container.element);
    scrollIntoView.mockClear();

    rerender(<MessageList state={state({ streamingText: "partial answer grows" })} scrollRef={container.ref} />);

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(container.metrics.scrollTop).toBe(200);
  });

  it("holds a scrolled-up reader when the answer finishes", () => {
    const user = { id: "u1", role: "user" as const, text: "question" };
    const container = scrollContainer({ scrollTop: 500, scrollHeight: 1000, clientHeight: 500 });
    const { rerender } = render(
      <MessageList
        state={state({ messages: [user], pendingUserText: null, streamingText: "the answer" })}
        scrollRef={container.ref}
      />,
    );
    container.metrics.scrollTop = 200;
    fireEvent.scroll(container.element);
    scrollIntoView.mockClear();
    rerender(
      <MessageList
        state={state({
          messages: [user, { id: "a1", role: "assistant", text: "the answer" }],
          pendingUserText: null,
          streamingText: "",
          status: "idle",
        })}
        scrollRef={container.ref}
      />,
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
    const container = scrollContainer({ scrollTop: 500, scrollHeight: 1000, clientHeight: 500 });

    const { rerender } = render(
      <MessageList
        state={state({
          messages: transcript,
          pendingUserText: null,
          streamingText: "streaming from the top",
        })}
        scrollRef={container.ref}
      />,
    );

    // The reader scrolls up while the next answer streams in.
    container.metrics.scrollTop = 200;
    fireEvent.scroll(container.element);
    scrollIntoView.mockClear();

    // The reader sends a new message: its draft bubble appears, which is the
    // only thing `send` does to the transcript. It must never end up off-screen.
    rerender(
      <MessageList
        state={state({
          messages: transcript,
          pendingUserText: "a new question",
          streamingText: "streaming from the top",
        })}
        scrollRef={container.ref}
      />,
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    // And the reader is pinned again, so the next token keeps following.
    scrollIntoView.mockClear();
    rerender(
      <MessageList
        state={state({
          messages: transcript,
          pendingUserText: "a new question",
          streamingText: "streaming from the top, one token later",
        })}
        scrollRef={container.ref}
      />,
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
