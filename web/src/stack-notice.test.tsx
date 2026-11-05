import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App.tsx";
import { ChatWindow } from "./components/ChatWindow.tsx";
import {
  chatReducer,
  initialChatState,
  stackNoticesFor,
  type ChatState,
} from "./lib/chat-reducer.ts";
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

const NOTICE = "ingest_jobs_list ran on Stack stack-b, not the session's Stack stack-a.";
/** The same foreign Stack, reached by a different tool: a second, distinct fact. */
const NOTICE_OTHER = "ingest_job_get ran on Stack stack-b, not the session's Stack stack-a.";
/** Two conversations, so a notice can be attributed to the turn that produced it. */
const A = "conv-a";
const B = "conv-b";

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
      { type: "stack_notice", conversationId: A, tool: "ingest_jobs_list", text: NOTICE },
      { type: "finished", outcome: "ok" },
      { type: "loaded", messages: [{ id: "m0", role: "assistant", text: "done" }] },
    ]);
    expect(stackNoticesFor(state, A)).toEqual([NOTICE]);
  });

  it("belongs to one turn only", () => {
    const after = run([
      { type: "send", text: "first" },
      { type: "stack_notice", conversationId: A, tool: "ingest_jobs_list", text: NOTICE },
      { type: "finished", outcome: "ok" },
      { type: "send", text: "second" },
    ]);
    expect(stackNoticesFor(after, A)).toEqual([]);
  });

  it("is dropped when another conversation is opened", () => {
    const after = run([
      { type: "stack_notice", conversationId: A, tool: "ingest_jobs_list", text: NOTICE },
      { type: "reset" },
    ]);
    expect(stackNoticesFor(after, A)).toEqual([]);
  });

  it("says it once however many times the same call is reported", () => {
    const after = run([
      { type: "stack_notice", conversationId: A, tool: "ingest_jobs_list", text: NOTICE },
      { type: "stack_notice", conversationId: A, tool: "ingest_jobs_list", text: NOTICE },
    ]);
    expect(stackNoticesFor(after, A)).toEqual([NOTICE]);
  });

  it("keeps two divergent calls on the same foreign Stack apart", () => {
    // Two calls, one foreign Stack: with a sentence that named no tool these would be one
    // line naming no call, and a reader could not tell whether one call or five had left
    // the session's Stack.
    const after = run([
      { type: "stack_notice", conversationId: A, tool: "ingest_jobs_list", text: NOTICE },
      { type: "stack_notice", conversationId: A, tool: "ingest_job_get", text: NOTICE_OTHER },
    ]);
    expect(stackNoticesFor(after, A)).toEqual([NOTICE, NOTICE_OTHER]);
  });

  it("keys the dedupe on the tool, not on the sentence alone", () => {
    // The sentence names the tool today, so these two cannot come off the wire in the
    // current wording. What is under test is the KEY: a rewording that dropped the tool
    // from the sentence must not silently merge two different calls into one line again.
    const after = run([
      { type: "stack_notice", conversationId: A, tool: "ingest_jobs_list", text: NOTICE },
      { type: "stack_notice", conversationId: A, tool: "ingest_job_get", text: NOTICE },
    ]);
    expect(stackNoticesFor(after, A)).toEqual([NOTICE, NOTICE]);
  });
});

/**
 * A notice is about ONE turn in ONE conversation, and the thread on screen is the only
 * thing a person can be reading.
 *
 * `openConversation` aborts the previous stream and resets the state, but the frame loop
 * of the run it aborted keeps draining into whatever state exists when its next frame
 * arrives, and `loaded` now keeps notices. Without a stamp, a sentence about a tool call
 * made in conversation A could therefore be painted in conversation B — a claim about a
 * turn that never happened there.
 */
describe("a notice is only shown in the conversation that produced it", () => {
  it("is not shown in another conversation's thread", () => {
    const state = run([
      { type: "send", text: "list the jobs" },
      { type: "stack_notice", conversationId: A, tool: "ingest_jobs_list", text: NOTICE },
      // The user opens B: abort, reset, then the reload of B's thread.
      { type: "reset" },
      { type: "loaded", messages: [{ id: "m0", role: "assistant", text: "older answer" }] },
      // A frame from A's still-draining run lands here.
      { type: "stack_notice", conversationId: A, tool: "ingest_jobs_list", text: NOTICE },
    ]);
    expect(stackNoticesFor(state, B)).toEqual([]);
  });

  it("is shown in the conversation it arrived in", () => {
    const state = run([
      { type: "stack_notice", conversationId: A, tool: "ingest_jobs_list", text: NOTICE },
      { type: "loaded", messages: [] },
    ]);
    expect(stackNoticesFor(state, A)).toEqual([NOTICE]);
    // With no conversation on screen there is nothing to attribute, so nothing is shown.
    expect(stackNoticesFor(state, null)).toEqual([]);
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

/**
 * A turn whose frames the TEST pushes.
 *
 * `openConversation` aborts the previous stream, but a read that was already in flight
 * can still deliver frames afterwards — that is the race this file's attribution test
 * reproduces. A stub that answers every frame at once cannot express it.
 */
function stubStreamingTurn(): { readonly opened: boolean; push(frame: string): void } {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream$ = { opened: false };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init: RequestInit = {}) => {
      const url = String(input);
      const method = (init.method ?? "GET").toUpperCase();
      if (url.endsWith("/me")) {
        return new Response(JSON.stringify({ id: "alice", displayName: "alice" }));
      }
      if (method === "POST" && url.endsWith("/conversations")) {
        return new Response(JSON.stringify({ id: A, title: "hola", createdAt: "", updatedAt: "" }), {
          status: 201,
        });
      }
      if (url.endsWith(`/conversations/${A}/turns`)) {
        stream$.opened = true;
        const body = new ReadableStream<Uint8Array>({
          start: (c) => {
            controller = c;
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.endsWith(`/conversations/${B}`)) {
        return new Response(
          JSON.stringify({
            id: B,
            title: "older",
            createdAt: "",
            updatedAt: "",
            messages: [{ id: "m0", role: "assistant", text: "older answer" }],
          }),
        );
      }
      return new Response(
        JSON.stringify({ conversations: [{ id: B, title: "older", createdAt: "", updatedAt: "" }] }),
      );
    }),
  );

  return {
    get opened() {
      return stream$.opened;
    },
    push(frame: string) {
      controller?.enqueue(encoder.encode(`data: ${frame}\n\n`));
    },
  };
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

function mountWindow(state: ChatState, conversationId: string | null) {
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

describe("the window paints only the notice of the thread it is showing", () => {
  it("paints the notice of the displayed conversation", () => {
    const state = run([{ type: "stack_notice", conversationId: A, tool: "ingest_jobs_list", text: NOTICE }]);
    const { container } = mountWindow(state, A);
    expect(container.querySelectorAll(".chat__stack-notice")).toHaveLength(1);
    expect(screen.getByText(NOTICE)).toBeDefined();
  });

  it("paints nothing for a notice stamped with another conversation", () => {
    const state = run([{ type: "stack_notice", conversationId: A, tool: "ingest_jobs_list", text: NOTICE }]);
    const { container } = mountWindow(state, B);
    expect(container.querySelectorAll(".chat__stack-notice")).toHaveLength(0);
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});

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

  it("never paints a late frame from conversation A in conversation B", async () => {
    window.history.replaceState(null, "", "/?user=alice&stackId=stack-a");
    const stream = stubStreamingTurn();
    render(<App />);
    await screen.findByText("New chat");
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "list the jobs" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(stream.opened).toBe(true));

    // The user opens the other conversation while A's run is still on the wire.
    fireEvent.click(await screen.findByText("older"));
    await screen.findByText("older answer");

    // A's next frames arrive anyway. The activity row is the landing proof: it is reduced
    // into the very same state (its own attribution is a pre-existing gap, out of scope
    // here), so if the notice were painted this is the state it would be painted from.
    stream.push(STARTED);
    stream.push(finished({ notice: NOTICE }));
    await screen.findByText("ingest jobs list");

    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(document.querySelectorAll(".chat__stack-notice")).toHaveLength(0);
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
