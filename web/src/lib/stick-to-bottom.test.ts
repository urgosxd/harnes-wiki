import { describe, it, expect, vi } from "vitest";
import { createElement, type RefObject } from "react";
import { render } from "@testing-library/react";
import { isPinnedToBottom, useStickToBottom } from "./stick-to-bottom.ts";

// Content 1000px tall in a 400px viewport: the bottom sits at scrollTop 600.
function at(scrollTop: number, scrollHeight = 1000, clientHeight = 400) {
  return { scrollTop, scrollHeight, clientHeight };
}

describe("isPinnedToBottom", () => {
  it("treats a reader exactly at the bottom as pinned", () => {
    expect(isPinnedToBottom(at(600))).toBe(true);
  });

  it("treats a reader within the threshold as pinned", () => {
    // 10px between the viewport bottom and the content bottom.
    expect(isPinnedToBottom(at(590))).toBe(true);
  });

  it("treats a gap exactly equal to the threshold as pinned", () => {
    // Boundary: 24px gap with the default threshold of 24.
    expect(isPinnedToBottom(at(576))).toBe(true);
  });

  it("treats a gap just past the threshold as not pinned", () => {
    // 25px gap, one pixel beyond the default threshold.
    expect(isPinnedToBottom(at(575))).toBe(false);
  });

  it("treats a reader far above the bottom as not pinned", () => {
    expect(isPinnedToBottom(at(100))).toBe(false);
  });

  it("does not pin a container shorter than its content at scrollTop 0", () => {
    // Content 2000px tall in a 400px viewport, still showing the top.
    expect(isPinnedToBottom(at(0, 2000, 400))).toBe(false);
  });

  it("pins a container whose content fits without scrolling", () => {
    expect(isPinnedToBottom(at(0, 300, 400))).toBe(true);
  });

  it("honours a custom threshold", () => {
    // 200px gap, inside a 400px threshold but far outside a 5px one.
    expect(isPinnedToBottom(at(400), 200)).toBe(true);
    expect(isPinnedToBottom(at(400), 5)).toBe(false);
    expect(isPinnedToBottom(at(598), 5)).toBe(true);
  });
});

/**
 * jsdom has no layout, so a container is lent real metrics; nothing here reads
 * them, but the transcript does when it decides whether to follow the answer.
 */
function scrollContainer(metrics: { scrollTop: number; scrollHeight: number; clientHeight: number }) {
  const element = document.createElement("div");
  const current = { ...metrics };
  Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => current.scrollHeight });
  Object.defineProperty(element, "clientHeight", { configurable: true, get: () => current.clientHeight });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => current.scrollTop,
    set: (value: number) => {
      current.scrollTop = value;
    },
  });
  const ref: RefObject<HTMLElement | null> = { current: element };
  return { ref, element };
}

// This file is TypeScript, not TSX, so the host component is a createElement call.
//
// The host calls the hook the way the chat window does — the component that owns the
// scroll container — with the container handed in, so a test can swap it. The options are
// the quiet ones: no streaming, no conversation, nothing that asks for a scroll on its own.
const endRef: RefObject<HTMLElement | null> = { current: null };

function Host({ container }: { container: RefObject<HTMLElement | null> }) {
  useStickToBottom(container, endRef, {
    streaming: false,
    contentKey: "",
    sentCount: 0,
    conversationId: null,
    loadingThread: false,
  });
  return null;
}

function transcript(container: RefObject<HTMLElement | null>) {
  // The same component type every time, so a rerender is an update and not a remount:
  // the test is about a listener moving between containers, not about unmounting.
  return createElement(Host, { container });
}

function scrollListener(calls: unknown[][]): unknown {
  return calls.find(([type]) => type === "scroll")?.[1];
}

/**
 * The pin is decided by a listener attached to the scroll container, so its
 * lifecycle is part of the rule: a listener that outlives its transcript, or
 * one left behind by a swapped container, would decide the pin from stale data.
 */
describe("useStickToBottom listener lifecycle", () => {
  it("removes the scroll listener when the transcript unmounts", () => {
    const container = scrollContainer({ scrollTop: 500, scrollHeight: 1000, clientHeight: 500 });
    const add = vi.spyOn(container.element, "addEventListener");
    const remove = vi.spyOn(container.element, "removeEventListener");

    const { unmount } = render(transcript(container.ref));

    const added = scrollListener(add.mock.calls);
    // Without this, a hook that never attached would satisfy "nothing left behind".
    expect(added).toBeTypeOf("function");

    unmount();

    // The exact function that was added must be the one removed: an event name
    // match alone would pass even if a different handler were deregistered.
    expect(scrollListener(remove.mock.calls)).toBe(added);
  });

  it("re-attaches the listener when the container changes", () => {
    const first = scrollContainer({ scrollTop: 500, scrollHeight: 1000, clientHeight: 500 });
    const second = scrollContainer({ scrollTop: 0, scrollHeight: 1000, clientHeight: 500 });
    const addFirst = vi.spyOn(first.element, "addEventListener");
    const removeFirst = vi.spyOn(first.element, "removeEventListener");
    const addSecond = vi.spyOn(second.element, "addEventListener");

    const { rerender } = render(transcript(first.ref));
    const firstListener = scrollListener(addFirst.mock.calls);
    expect(firstListener).toBeTypeOf("function");

    rerender(transcript(second.ref));

    // The old container must not keep a listener that still moves the pin.
    expect(scrollListener(removeFirst.mock.calls)).toBe(firstListener);
    // And the new one must be watched, or scrolling in it would never unpin.
    expect(scrollListener(addSecond.mock.calls)).toBeTypeOf("function");
  });
});
