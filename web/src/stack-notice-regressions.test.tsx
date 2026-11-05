import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChatWindow } from "./components/ChatWindow.tsx";
import {
  chatReducer,
  initialChatState,
  stackNoticesFor,
  type ChatAction,
  type ChatState,
} from "./lib/chat-reducer.ts";

/**
 * The visible Stack notice at the SURFACE, probed independently of the reducer's own
 * tests.
 *
 * Adapted from the read-only verification pass over `01180f1`/`ecaa446`, kept as a
 * durable artifact in the style of `../server/test/stack-scope-gate.test.ts`: these are
 * the assertions a person's screen depends on, stated as behaviour rather than as prose.
 *
 * What is pinned: the sentence is its own line in the turn's output; it is absent when
 * nothing diverged; two divergent calls are two lines; it survives the reload that ends
 * the turn and does not follow the user into another turn or another conversation; and a
 * `tool_finished` frame that carries no notice still closes its activity row, which is
 * what keeps an older client working.
 */

const NOTICE = "ingest_jobs_list was sent to Stack stack-b, not the session's Stack stack-a.";
const OTHER = "ingest_job_get was sent to Stack stack-c, not the session's Stack stack-a.";
/** The conversation these turns run in. A notice about a turn belongs to its thread. */
const CONVERSATION = "conv-a";

function run(actions: ChatAction[], from: ChatState = initialChatState): ChatState {
  return actions.reduce(chatReducer, from);
}

function mount(state: ChatState, conversationId: string | null = CONVERSATION) {
  return render(
    <ChatWindow
      state={state}
      conversationId={conversationId}
      loadingThread={false}
      onSend={() => {}}
      onRetry={() => {}}
      onStop={() => {}}
      onOpenSidebar={() => {}}
    />,
  );
}

function lines(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll(".chat__stack-notice")].map((element) => element.textContent);
}

describe("the divergent Stack reaches a rendered surface", () => {
  it("renders the sentence as its own line, not as assistant text", () => {
    const state = run([
      { type: "send", text: "hi" },
      { type: "delta", delta: "the answer" },
      { type: "stack_notice", conversationId: CONVERSATION, tool: "ingest_jobs_list", text: NOTICE },
      { type: "finished", outcome: "ok" },
    ]);
    mount(state);

    expect(screen.getByText(NOTICE)).toBeDefined();
    expect(screen.getByText(NOTICE).className).toBe("chat__stack-notice");
    expect(screen.getByRole("status").textContent).toBe(NOTICE);
    // And the assistant's own text is still exactly what the model said.
    expect(screen.getByText("the answer")).toBeDefined();
  });

  it("renders nothing when no notice arrived", () => {
    const state = run([
      { type: "send", text: "hi" },
      { type: "delta", delta: "the answer" },
      { type: "finished", outcome: "ok" },
    ]);
    const { container } = mount(state);
    expect(container.querySelectorAll(".chat__stack-notice")).toHaveLength(0);
  });

  it("shows two divergent calls in one turn as two lines, in order", () => {
    const state = run([
      { type: "send", text: "hi" },
      { type: "stack_notice", conversationId: CONVERSATION, tool: "ingest_jobs_list", text: NOTICE },
      { type: "stack_notice", conversationId: CONVERSATION, tool: "ingest_job_get", text: OTHER },
      { type: "finished", outcome: "ok" },
      { type: "loaded", messages: [] },
    ]);
    const { container } = mount(state);
    expect(lines(container)).toEqual([NOTICE, OTHER]);
  });

  it("does not carry a notice into the next turn", () => {
    const after = run([
      { type: "send", text: "first" },
      { type: "stack_notice", conversationId: CONVERSATION, tool: "ingest_jobs_list", text: NOTICE },
      { type: "finished", outcome: "ok" },
      { type: "loaded", messages: [] },
      { type: "send", text: "second" },
    ]);
    const { container } = mount(after);
    expect(container.querySelectorAll(".chat__stack-notice")).toHaveLength(0);
  });

  it("survives the end-of-turn reload but not a conversation switch", () => {
    const kept = run([
      { type: "send", text: "x" },
      { type: "stack_notice", conversationId: CONVERSATION, tool: "ingest_jobs_list", text: NOTICE },
      { type: "finished", outcome: "ok" },
      { type: "loaded", messages: [{ id: "m", role: "assistant", text: "done" }] },
    ]);
    expect(stackNoticesFor(kept, CONVERSATION)).toEqual([NOTICE]);
    expect(stackNoticesFor(run([{ type: "reset" }], kept), CONVERSATION)).toEqual([]);

    // A failed turn keeps it on screen (no reload happens on failure), and a retry clears
    // it, because the retry is a new turn.
    const failed = run([{ type: "failed", message: "boom", retryable: true }], kept);
    expect(stackNoticesFor(failed, CONVERSATION)).toEqual([NOTICE]);
    expect(stackNoticesFor(run([{ type: "send", text: "x" }], failed), CONVERSATION)).toEqual([]);
  });

  it("is not painted in a conversation other than the one the turn ran in", () => {
    // The run it belongs to may still be draining when the user opens another thread.
    const state = run([
      { type: "reset" },
      { type: "loaded", messages: [] },
      { type: "stack_notice", conversationId: CONVERSATION, tool: "ingest_jobs_list", text: NOTICE },
    ]);
    const { container } = mount(state, "conv-b");
    expect(container.querySelectorAll(".chat__stack-notice")).toHaveLength(0);
  });

  it("old client path: a finished-call action without a notice still closes the row", () => {
    const state = run([
      { type: "send", text: "x" },
      { type: "tool_started", tool: "ingest_jobs_list", label: "ingest jobs list" },
      { type: "tool_finished", tool: "ingest_jobs_list", label: "ingest jobs list", isError: false },
    ]);
    const row = state.activity.find((item) => item.kind === "tool");
    expect(row?.done).toBe(true);
    expect(stackNoticesFor(state, CONVERSATION)).toEqual([]);
  });
});
