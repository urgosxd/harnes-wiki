import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";
import { ChatWindow } from "./ChatWindow.tsx";
import { initialChatState, type ChatState } from "../lib/chat-reducer.ts";
import type { Message } from "../lib/api.ts";

/**
 * The two ways the chat reaches the end of a conversation: opening it, and the control
 * that jumps back while the reader is up in the history.
 *
 * jsdom has no layout engine, so `scrollTop`, `scrollHeight` and `clientHeight` are zero
 * and `scrollIntoView` does nothing. These tests therefore prove the DECISION and the
 * REQUEST, never the pixels: they lend the real `.chat__scroll` element the three numbers
 * a browser would report, drive position changes with the same `scroll` event a browser
 * fires, and count the one DOM call that can move a viewport. What a real browser still
 * has to confirm is written down in `odd/tasks/chat-jump-to-latest.md` (L4).
 */
interface Metrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Bottom of a 1000px transcript in a 400px viewport: 600px of scroll. */
const AT_BOTTOM: Metrics = { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 };
/** The same transcript, read from the top. */
const AT_TOP: Metrics = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };

let scrollIntoView: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // vitest.setup.ts installs a no-op; replace it so requests can be counted.
  scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView as unknown as Element["scrollIntoView"];
});

/** A history long enough to scroll: `turns` question/answer pairs. */
function thread(prefix: string, turns: number): Message[] {
  const messages: Message[] = [];
  for (let n = 1; n <= turns; n += 1) {
    messages.push({ id: `${prefix}-u${n}`, role: "user", text: `${prefix} question ${n}` });
    messages.push({ id: `${prefix}-a${n}`, role: "assistant", text: `${prefix} answer ${n}` });
  }
  return messages;
}

const handlers = { onSend() {}, onRetry() {}, onStop() {}, onOpenSidebar() {} };

interface Window {
  render: RenderResult["rerender"];
  rerender(state: ChatState, conversationId: string | null, loadingThread?: boolean): void;
  scroller: HTMLElement;
  metrics: Metrics;
  unmount(): void;
}

/**
 * Lend the scroll container the three numbers jsdom will not report. Defined on the real
 * element the component created, so the geometry the component reads at scroll time is
 * this object.
 */
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

function openWindow(
  state: ChatState,
  conversationId: string | null,
  options: { loadingThread?: boolean; metrics?: Metrics } = {},
): Window {
  const { loadingThread = false, metrics = { ...AT_BOTTOM } } = options;
  const view = render(
    <ChatWindow
      state={state}
      conversationId={conversationId}
      loadingThread={loadingThread}
      {...handlers}
    />,
  );
  const scroller = view.container.querySelector(".chat__scroll");
  if (!(scroller instanceof HTMLElement)) throw new Error("the chat has no scroll container");
  lendMetrics(scroller, metrics);
  return {
    render: view.rerender,
    rerender: (next: ChatState, id: string | null, loading = false) =>
      view.rerender(
        <ChatWindow state={next} conversationId={id} loadingThread={loading} {...handlers} />,
      ),
    scroller,
    metrics,
    unmount: view.unmount,
  };
}

/** The reader drags the viewport to a position; the container reports it, as a browser would. */
function scrollTo(window: Window, metrics: Partial<Metrics>): void {
  Object.assign(window.metrics, metrics);
  fireEvent.scroll(window.scroller);
}

function loaded(messages: Message[], overrides: Partial<ChatState> = {}): ChatState {
  return { ...initialChatState, messages, ...overrides };
}

describe("a conversation opens on its last message (S2)", () => {
  it("requests the jump to the last message as soon as the conversation is on screen", () => {
    openWindow(loaded(thread("a", 12)), "conv-a");
    // The exact argument is the assertion: no `behavior: "smooth"`, so a long jump is
    // instant instead of a slide through the whole history.
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "end" });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("requests it again for a different conversation with the same number of turns", () => {
    // Both histories are the same shape, so nothing about the reader's own message count
    // or the transcript's length changes: only the selected conversation does.
    const window = openWindow(loaded(thread("a", 12)), "conv-a");
    scrollTo(window, AT_TOP);
    scrollIntoView.mockClear();

    window.rerender(loaded(thread("b", 12)), "conv-b");

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "end" });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("requests it again when the reader comes back to a conversation they already had open", () => {
    const window = openWindow(loaded(thread("a", 12)), "conv-a");
    window.rerender(loaded(thread("b", 12)), "conv-b");
    scrollTo(window, AT_TOP);
    scrollIntoView.mockClear();

    window.rerender(loaded(thread("a", 12)), "conv-a");

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("waits for the history to arrive instead of landing on an empty frame", () => {
    const window = openWindow(initialChatState, "conv-a", { loadingThread: true });
    expect(scrollIntoView).not.toHaveBeenCalled();

    window.rerender(loaded(thread("a", 12)), "conv-a");

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "end" });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("asks for nothing when there is no conversation on screen", () => {
    // A brand-new chat: there is no history to land on, so nothing to request.
    openWindow(initialChatState, null);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(screen.getByText("Ask anything to start.")).toBeDefined();
  });
});

describe("the way back to the last message while reading (S3-S5)", () => {
  /** The control, found the way a screen reader finds it: by role and name. */
  const control = () => screen.queryByRole("button", { name: /jump to latest message/i });

  it("is offered once the reader is away from the bottom, under a name that says what it does", () => {
    const window = openWindow(loaded(thread("a", 12)), "conv-a");
    // Opening put the viewport at the end, so there is nothing to jump to yet.
    expect(control()).toBeNull();

    scrollTo(window, AT_TOP);

    // The exact name, computed from the accessible tree: the arrow beside the words is
    // decorative, so a reader is told what the control DOES, not that it points down.
    expect(screen.getByRole("button", { name: "Jump to latest message" })).toBeDefined();
  });

  it("can be reached with the keyboard", () => {
    const window = openWindow(loaded(thread("a", 12)), "conv-a");
    scrollTo(window, AT_TOP);

    const button = screen.getByRole("button", { name: /jump to latest message/i });
    button.focus();

    expect(document.activeElement).toBe(button);
  });

  it("is gone at the bottom, because a button that does nothing is noise", () => {
    const window = openWindow(loaded(thread("a", 12)), "conv-a");
    expect(control()).toBeNull();

    scrollTo(window, { scrollTop: 300 });
    expect(control()).not.toBeNull();

    scrollTo(window, AT_BOTTOM);
    expect(control()).toBeNull();
  });

  it("requests the jump when clicked, and disappears because the click put the reader at the end", () => {
    const window = openWindow(loaded(thread("a", 12)), "conv-a");
    scrollTo(window, AT_TOP);
    scrollIntoView.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /jump to latest message/i }));

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "end" });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(control()).toBeNull();
  });

  it("marks something new instead of moving a reader who is scrolled up (S5)", () => {
    const window = openWindow(
      loaded(thread("a", 3), { status: "streaming", streamingText: "the answer so far" }),
      "conv-a",
    );
    scrollTo(window, AT_TOP);
    scrollIntoView.mockClear();

    window.rerender(
      loaded(thread("a", 3), { status: "streaming", streamingText: "the answer so far, and more" }),
      "conv-a",
    );

    // Not moved: the viewport stays exactly where the reader put it.
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(window.metrics.scrollTop).toBe(0);
    // And told that there is something below.
    const button = control();
    expect(button).not.toBeNull();
    expect(button?.textContent).toMatch(/new/i);
  });

  it("keeps following the answer while the reader is at the bottom, with no control (S6)", () => {
    const window = openWindow(
      loaded(thread("a", 3), { status: "streaming", streamingText: "the answer so far" }),
      "conv-a",
    );
    scrollIntoView.mockClear();

    window.rerender(
      loaded(thread("a", 3), { status: "streaming", streamingText: "the answer so far, and more" }),
      "conv-a",
    );

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "end" });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(control()).toBeNull();
  });

  it("is not offered where there is no transcript to jump through", () => {
    // S7: the empty state is untouched, and a control over nothing would be noise.
    openWindow(initialChatState, null);
    expect(screen.getByText("Ask anything to start.")).toBeDefined();
    expect(control()).toBeNull();
  });
});
