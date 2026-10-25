import { describe, it, expect } from "vitest";
import { chatReducer, initialChatState, type ChatState } from "./chat-reducer.ts";

function run(actions: Parameters<typeof chatReducer>[1][], from: ChatState = initialChatState): ChatState {
  return actions.reduce(chatReducer, from);
}

describe("chatReducer", () => {
  it("shows the user bubble while the answer streams", () => {
    const state = run([{ type: "send", text: "hello" }]);
    expect(state.status).toBe("streaming");
    expect(state.pendingUserText).toBe("hello");
    expect(state.messages).toHaveLength(0);
  });

  it("accumulates deltas in order", () => {
    const state = run([
      { type: "send", text: "hi" },
      { type: "delta", delta: "Hel" },
      { type: "delta", delta: "lo" },
    ]);
    expect(state.streamingText).toBe("Hello");
  });

  it("commits both turns when the run finishes", () => {
    const state = run([
      { type: "send", text: "hi" },
      { type: "delta", delta: "Hello!" },
      { type: "finished", outcome: "ok" },
    ]);

    expect(state.status).toBe("idle");
    expect(state.messages).toEqual([
      { id: "local-u-0", role: "user", text: "hi" },
      { id: "local-a-1", role: "assistant", text: "Hello!" },
    ]);
    expect(state.pendingUserText).toBeNull();
    expect(state.streamingText).toBe("");
  });

  it("keeps the user turn and offers a retry when the run fails", () => {
    const state = run([
      { type: "send", text: "hi" },
      { type: "delta", delta: "partial" },
      { type: "failed", message: "model unavailable", retryable: true },
    ]);

    expect(state.status).toBe("error");
    expect(state.error).toBe("model unavailable");
    expect(state.canRetry).toBe(true);
    // The partial reply stays visible: losing it would hide that the model started.
    expect(state.streamingText).toBe("partial");
    expect(state.pendingUserText).toBe("hi");
    expect(state.messages).toHaveLength(0);
  });

  it("explains an aborted run without calling it an error", () => {
    const state = run([
      { type: "send", text: "hi" },
      { type: "delta", delta: "Half an ans" },
      { type: "finished", outcome: "aborted" },
    ]);

    expect(state.status).toBe("idle");
    expect(state.error).toBe("Stopped.");
    expect(state.canRetry).toBe(false);
    expect(state.messages.at(-1)?.text).toBe("Half an ans");
  });

  it("explains a truncated answer", () => {
    const state = run([
      { type: "send", text: "hi" },
      { type: "delta", delta: "Long" },
      { type: "finished", outcome: "length" },
    ]);
    expect(state.error).toMatch(/cut off/);
  });

  it("does not add an empty assistant bubble for an empty answer", () => {
    const state = run([{ type: "send", text: "hi" }, { type: "finished", outcome: "ok" }]);
    expect(state.messages).toEqual([{ id: "local-u-0", role: "user", text: "hi" }]);
  });

  it("clears a previous error when a new turn is sent", () => {
    const failed = run([
      { type: "send", text: "one" },
      { type: "failed", message: "boom", retryable: true },
    ]);
    const retried = run([{ type: "send", text: "one" }], failed);

    expect(retried.error).toBeNull();
    expect(retried.canRetry).toBe(false);
    expect(retried.status).toBe("streaming");
  });

  it("replaces local messages when the conversation is reloaded", () => {
    const afterTurn = run([
      { type: "send", text: "hi" },
      { type: "delta", delta: "Hello" },
      { type: "finished", outcome: "ok" },
    ]);
    const reloaded = run(
      [{ type: "loaded", messages: [{ id: "srv-1", role: "user", text: "hi" }] }],
      afterTurn,
    );

    expect(reloaded.messages).toEqual([{ id: "srv-1", role: "user", text: "hi" }]);
    expect(reloaded.status).toBe("idle");
  });

  it("records the run id when the server reports it", () => {
    const state = run([{ type: "send", text: "hi" }, { type: "run_started", runId: "r-9" }]);
    expect(state.runId).toBe("r-9");
  });

  it("ignores tool frames without disturbing the text", () => {
    const state = run([
      { type: "send", text: "hi" },
      { type: "delta", delta: "a" },
      { type: "tool", tool: "get_order" },
      { type: "delta", delta: "b" },
    ]);
    expect(state.streamingText).toBe("ab");
  });
});
