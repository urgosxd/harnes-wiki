import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App.tsx";
import { chatReducer, initialChatState, type ChatState } from "./lib/chat-reducer.ts";
import { parseChatFrame } from "./lib/sse.ts";

/**
 * The Stack a call ran on must reach the PERSON, not just the log.
 *
 * The reviewer's objection, accepted by the requester: the old refusal named a foreign
 * Stack on screen, and a structured log record does not replace that — nobody reads it.
 * An explicit `stackId` argument still wins (S1), so the divergence has to be shown
 * where the user is already looking: in that turn's own output.
 *
 * These tests assert the effect a human sees, from the wire to the rendered sentence,
 * and assert its ABSENCE for the two cases that are not a divergence: the argument
 * naming the session's Stack, and no argument at all.
 */

function run(actions: Parameters<typeof chatReducer>[1][], from: ChatState = initialChatState): ChatState {
  return actions.reduce(chatReducer, from);
}

const NOTICE = "Ran on Stack stack-b, not the session's Stack stack-a.";

describe("the notice survives transport", () => {
  it("parses a finished-call frame that carries a notice, notice intact", () => {
    const frame = parseChatFrame(
      JSON.stringify({
        type: "tool_finished",
        tool: "ingest_jobs_list",
        label: "ingest jobs list",
        isError: false,
        notice: NOTICE,
      }),
    );
    expect(frame).toEqual({
      type: "tool_finished",
      tool: "ingest_jobs_list",
      label: "ingest jobs list",
      isError: false,
      notice: NOTICE,
    });
  });
});

describe("the notice outlives the turn", () => {
  it("is still shown after the reload that ends the turn", () => {
    // The client reloads the thread from the server once the run finishes, and that
    // reload is what used to leave a mid-turn remark on a screen nobody was watching.
    const state = run([
      { type: "send", text: "list the jobs" },
      { type: "stack_notice", text: NOTICE },
      { type: "finished", outcome: "ok" },
      { type: "loaded", messages: [{ id: "m0", role: "assistant", text: "done" }] },
    ]);
    expect(state.stackNotices).toEqual([NOTICE]);
  });

  it("belongs to one turn only", () => {
    const after = run([
      { type: "send", text: "first" },
      { type: "stack_notice", text: NOTICE },
      { type: "finished", outcome: "ok" },
      { type: "send", text: "second" },
    ]);
    expect(after.stackNotices).toEqual([]);
  });

  it("is dropped when another conversation is opened", () => {
    const after = run([
      { type: "stack_notice", text: NOTICE },
      { type: "reset" },
    ]);
    expect(after.stackNotices).toEqual([]);
  });

  it("says it once however many times the same call is reported", () => {
    const after = run([
      { type: "stack_notice", text: NOTICE },
      { type: "stack_notice", text: NOTICE },
    ]);
    expect(after.stackNotices).toEqual([NOTICE]);
  });
});

/** The tools the chat reads plus the turn stream a test wants to replay. */
function stubApi(turnFrames: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init: RequestInit = {}) => {
      const url = String(input);
      const method = (init.method ?? "GET").toUpperCase();
      if (url.endsWith("/me")) {
        return new Response(JSON.stringify({ id: "alice", displayName: "alice" }));
      }
      if (method === "POST" && url.endsWith("/conversations")) {
        return new Response(JSON.stringify({ id: "c1", title: "hola", createdAt: "", updatedAt: "" }), {
          status: 201,
        });
      }
      if (url.endsWith("/conversations/c1/turns")) {
        return new Response(turnFrames.map((data) => `data: ${data}\n\n`).join(""), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.endsWith("/conversations/c1")) {
        return new Response(
          JSON.stringify({ id: "c1", title: "hola", createdAt: "", updatedAt: "", messages: [] }),
        );
      }
      return new Response(JSON.stringify({ conversations: [] }));
    }),
  );
}

/** Open the chat, send one message and wait for the turn to finish. */
async function sendOneMessage(turnFrames: string[]): Promise<void> {
  window.history.replaceState(null, "", "/?user=alice&stackId=stack-a");
  stubApi(turnFrames);
  render(<App />);
  await screen.findByText("New chat");
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "list the jobs" } });
  fireEvent.click(screen.getByText("Send"));
  await waitFor(() => expect(screen.queryByText("Stop")).toBeNull());
}

function finished(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "tool_finished",
    tool: "ingest_jobs_list",
    label: "ingest jobs list",
    isError: false,
    ...extra,
  });
}

const STARTED = JSON.stringify({
  type: "tool_started",
  tool: "ingest_jobs_list",
  label: "ingest jobs list",
});
const DONE = JSON.stringify({ type: "run_finished", outcome: "ok" });

describe("App shows the divergent Stack in the turn's output", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the sentence the server sent", async () => {
    await sendOneMessage([STARTED, finished({ notice: NOTICE }), DONE]);
    await waitFor(() => expect(screen.getByText(NOTICE)).toBeDefined());
  });

  it("shows nothing when the call was not a divergence", async () => {
    // The two non-divergences — the argument naming the session's own Stack, and no
    // argument at all — are one frame on the wire: no `notice` field. The server tests
    // (`server/test/stack-notice.test.ts`) pin that both produce exactly that; here the
    // client must not invent a sentence of its own.
    await sendOneMessage([STARTED, finished(), DONE]);
    await waitFor(() => expect(screen.queryByText("Stop")).toBeNull());
    expect(screen.queryByText(/Ran on Stack/)).toBeNull();
    expect(screen.queryByText(/session had no Stack/)).toBeNull();
  });
});
