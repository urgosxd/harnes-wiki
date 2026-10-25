import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFrame, encodeNamedFrame, closingFrames } from "../src/pi/events.ts";

test("frames encode as valid SSE records", () => {
  const wire = encodeFrame({ type: "text_delta", delta: "ho\nla" });
  assert.ok(wire.startsWith("data: "));
  assert.ok(wire.endsWith("\n\n"));
  const payload = JSON.parse(wire.slice("data: ".length).trim());
  assert.deepEqual(payload, { type: "text_delta", delta: "ho\nla" });
});

test("named frames carry an event line", () => {
  const wire = encodeNamedFrame("delta", { type: "text_delta", delta: "x" });
  assert.match(wire, /^event: delta\ndata: /);
});

test("a successful run closes with its usage", () => {
  const frames = closingFrames({
    outcome: "ok",
    usage: { input: 10, output: 4, totalTokens: 14, costTotal: 0 },
  });
  assert.deepEqual(frames, [
    { type: "run_finished", outcome: "ok", usage: { input: 10, output: 4, totalTokens: 14, costTotal: 0 } },
  ]);
});

test("a successful run without usage still closes", () => {
  assert.deepEqual(closingFrames({ outcome: "ok" }), [{ type: "run_finished", outcome: "ok" }]);
});

test("a truncated run is reported as finished, not failed", () => {
  const frames = closingFrames({ outcome: "length" });
  assert.equal(frames[0]?.type, "run_finished");
});

test("an aborted run closes without an error", () => {
  assert.deepEqual(closingFrames({ outcome: "aborted" }), [
    { type: "run_finished", outcome: "aborted" },
  ]);
});

test("a provider error closes as run_failed and keeps the reason", () => {
  const frames = closingFrames({ outcome: "error", errorMessage: "400 bad model" });
  assert.deepEqual(frames, [
    { type: "run_failed", outcome: "error", message: "400 bad model" },
  ]);
});

test("a provider error without a message still explains itself", () => {
  const frames = closingFrames({ outcome: "error" });
  assert.equal(frames[0]?.type, "run_failed");
  assert.match(JSON.stringify(frames[0]), /no answer/);
});
