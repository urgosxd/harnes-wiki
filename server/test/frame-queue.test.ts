import { test } from "node:test";
import assert from "node:assert/strict";
import { FrameQueue } from "../src/api/frame-queue.ts";
import type { ChatFrame } from "../src/pi/events.ts";

test("a frame pushed before draining is yielded", async () => {
  const queue = new FrameQueue();
  queue.push({ type: "text_delta", delta: "a" });
  queue.close();

  const seen: ChatFrame[] = [];
  for await (const frame of queue.drain()) seen.push(frame);

  assert.deepEqual(seen, [{ type: "text_delta", delta: "a" }]);
});

test("a frame pushed while draining is yielded without waiting for close", async () => {
  const queue = new FrameQueue();
  const iterator = queue.drain()[Symbol.asyncIterator]();

  // Nothing buffered yet: this must not resolve until a frame arrives.
  const first = iterator.next();
  queue.push({ type: "text_delta", delta: "live" });
  const result = await first;

  assert.equal(result.done, false);
  assert.deepEqual(result.value, { type: "text_delta", delta: "live" });
  queue.close();
  assert.equal((await iterator.next()).done, true);
});

test("order is preserved across a burst", async () => {
  const queue = new FrameQueue();
  for (let index = 0; index < 100; index += 1) {
    queue.push({ type: "text_delta", delta: String(index) });
  }
  queue.close();

  const seen: string[] = [];
  for await (const frame of queue.drain()) {
    if (frame.type === "text_delta") seen.push(frame.delta);
  }
  assert.equal(seen.length, 100);
  assert.equal(seen[0], "0");
  assert.equal(seen[99], "99");
});

test("frames pushed after close are discarded, not leaked", async () => {
  const queue = new FrameQueue();
  queue.push({ type: "text_delta", delta: "kept" });
  queue.close();
  queue.push({ type: "text_delta", delta: "after close" });

  const seen: ChatFrame[] = [];
  for await (const frame of queue.drain()) seen.push(frame);
  assert.deepEqual(seen, [{ type: "text_delta", delta: "kept" }]);
});

test("draining a closed and empty queue ends immediately", async () => {
  const queue = new FrameQueue();
  queue.close();
  let count = 0;
  for await (const _frame of queue.drain()) count += 1;
  assert.equal(count, 0);
});

test("an awaiting consumer is woken by close alone", async () => {
  const queue = new FrameQueue();
  const iterator = queue.drain()[Symbol.asyncIterator]();
  const pending = iterator.next();
  queue.close();
  assert.equal((await pending).done, true);
});
