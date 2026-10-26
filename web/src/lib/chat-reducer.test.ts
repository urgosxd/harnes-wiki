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

  it("shows a single Thinking step however many thinking chunks arrive", () => {
    const state = run([
      { type: "send", text: "hi" },
      { type: "thinking", delta: "let me " },
      { type: "thinking", delta: "consider " },
      { type: "thinking", delta: "this" },
    ]);

    expect(state.activity).toHaveLength(1);
    expect(state.activity[0]).toMatchObject({ kind: "thinking", label: "Thinking…" });
  });

  it("does not mix reasoning into the answer", () => {
    const state = run([
      { type: "send", text: "hi" },
      { type: "thinking", delta: "secret deliberation" },
      { type: "delta", delta: "the answer" },
    ]);

    expect(state.streamingText).toBe("the answer");
    expect(JSON.stringify(state.messages)).not.toContain("secret deliberation");
  });

  it("reports a skill once even when it appears repeatedly", () => {
    const state = run([
      { type: "send", text: "hi" },
      { type: "skill", name: "support-guide" },
      { type: "skill", name: "support-guide" },
    ]);

    expect(state.activity).toEqual([
      { id: "skill-0", kind: "skill", label: "Reading support-guide", done: true },
    ]);
  });

  it("keeps a running tool visible until it finishes", () => {
    const running = run([
      { type: "send", text: "hi" },
      { type: "tool_started", tool: "read", label: "Reading a document" },
    ]);
    expect(running.activity[0]).toMatchObject({ done: false });

    const finished = run(
      [{ type: "tool_finished", tool: "read", label: "Reading a document", isError: false }],
      running,
    );
    expect(finished.activity[0]).toMatchObject({ done: true, failed: false });
  });

  it("closes the right call when the same tool runs twice", () => {
    const state = run([
      { type: "send", text: "hi" },
      { type: "tool_started", tool: "read", label: "Reading a document" },
      { type: "tool_started", tool: "read", label: "Reading a document" },
      { type: "tool_finished", tool: "read", label: "Reading a document", isError: false },
    ]);

    expect(state.activity).toHaveLength(2);
    // The first call opened is the first one closed.
    expect(state.activity[0]?.done).toBe(true);
    expect(state.activity[1]).toMatchObject({ done: false });
  });

  it("marks a failed tool call", () => {
    const state = run([
      { type: "send", text: "hi" },
      { type: "tool_started", tool: "read", label: "Reading a document" },
      { type: "tool_finished", tool: "read", label: "Reading a document", isError: true },
    ]);

    expect(state.activity[0]).toMatchObject({ done: true, failed: true });
  });

  it("keeps the activity after the turn so the user can see what was done", () => {
    const state = run([
      { type: "send", text: "hi" },
      { type: "tool_started", tool: "ls", label: "Checking the workspace" },
      { type: "tool_finished", tool: "ls", label: "Checking the workspace", isError: false },
      { type: "delta", delta: "done" },
      { type: "finished", outcome: "ok" },
    ]);

    expect(state.status).toBe("idle");
    expect(state.activity).toHaveLength(1);
  });

  it("clears the activity when a new turn starts", () => {
    const afterTurn = run([
      { type: "send", text: "hi" },
      { type: "tool_started", tool: "ls", label: "Checking the workspace" },
      { type: "finished", outcome: "ok" },
    ]);
    const next = run([{ type: "send", text: "again" }], afterTurn);
    expect(next.activity).toEqual([]);
  });

  it("records the run id when the server reports it", () => {
    const state = run([{ type: "send", text: "hi" }, { type: "run_started", runId: "r-9" }]);
    expect(state.runId).toBe("r-9");
  });

  it("records tool activity without disturbing the text", () => {
    const state = run([
      { type: "send", text: "hi" },
      { type: "delta", delta: "a" },
      { type: "tool_started", tool: "get_order", label: "Looking up an order" },
      { type: "delta", delta: "b" },
      { type: "tool_finished", tool: "get_order", label: "Looking up an order", isError: false },
    ]);

    expect(state.streamingText).toBe("ab");
    expect(state.activity).toEqual([
      { id: "tool-get_order-0", kind: "tool", label: "Looking up an order", done: true, failed: false },
    ]);
  });
});
