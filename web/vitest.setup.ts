import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Without this, each render appends to the same document and queries match
// elements from previous tests.
afterEach(() => {
  cleanup();
});

// jsdom has no layout engine, so scrollIntoView does not exist. The component must
// not depend on its presence at runtime either: a browser without it would crash
// the chat window.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}
