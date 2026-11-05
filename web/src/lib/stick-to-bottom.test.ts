import { describe, it, expect } from "vitest";
import { isPinnedToBottom } from "./stick-to-bottom.ts";

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
