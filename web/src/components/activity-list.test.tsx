import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ActivityList } from "./ActivityList.tsx";
import { MessageList } from "./MessageList.tsx";
import { initialChatState, type ChatState, type ActivityItem } from "../lib/chat-reducer.ts";

function item(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return { id: "a1", kind: "tool", label: "Reading a document", done: true, ...overrides };
}

describe("ActivityList", () => {
  it("shows a generic working indicator when nothing is reported yet", () => {
    render(<ActivityList items={[]} streaming />);
    expect(screen.getByText("Working…")).toBeDefined();
  });

  it("renders nothing once the turn ended with no activity", () => {
    const { container } = render(<ActivityList items={[]} streaming={false} />);
    expect(container.textContent).toBe("");
  });

  it("shows a spinner for a running tool and a check for a finished one", () => {
    const { container } = render(
      <ActivityList
        items={[item({ id: "1", done: false }), item({ id: "2", done: true })]}
        streaming
      />,
    );
    expect(container.querySelectorAll(".spinner")).toHaveLength(1);
    expect(screen.getAllByText("✓")).toHaveLength(1);
  });

  it("marks a failed step", () => {
    const { container } = render(
      <ActivityList items={[item({ done: true, failed: true })]} streaming />,
    );
    expect(container.querySelector(".activity__row--failed")).not.toBeNull();
    expect(screen.getByText("✕")).toBeDefined();
  });

  it("keeps finished activity visible after the turn", () => {
    render(<ActivityList items={[item({ label: "Checking the workspace" })]} streaming={false} />);
    expect(screen.getByText("Checking the workspace")).toBeDefined();
  });

  it("is announced to assistive technology", () => {
    render(<ActivityList items={[item()]} streaming />);
    expect(screen.getByLabelText("Assistant activity").getAttribute("aria-live")).toBe("polite");
  });
});

describe("MessageList with activity", () => {
  function state(overrides: Partial<ChatState> = {}): ChatState {
    return { ...initialChatState, ...overrides };
  }

  it("shows the activity while the answer streams", () => {
    render(
      <MessageList
        state={state({
          status: "streaming",
          pendingUserText: "hi",
          activity: [item({ label: "Searching the workspace" })],
        })}
      />,
    );
    expect(screen.getByText("Searching the workspace")).toBeDefined();
    expect(screen.getByText("hi")).toBeDefined();
  });

  it("shows the working indicator before any text arrives", () => {
    render(<MessageList state={state({ status: "streaming", pendingUserText: "hi" })} />);
    expect(screen.getByText("Working…")).toBeDefined();
  });

  it("does not duplicate a thinking row with the answer", () => {
    render(
      <MessageList
        state={state({
          status: "streaming",
          streamingText: "the answer",
          activity: [item({ kind: "thinking", label: "Thinking…" })],
        })}
      />,
    );
    // One row in the activity list, and the answer once.
    expect(screen.getAllByText("Thinking…")).toHaveLength(1);
    expect(screen.getByText(/the answer/)).toBeDefined();
  });

  it("keeps the activity after the turn finishes", () => {
    render(
      <MessageList
        state={state({
          status: "idle",
          messages: [{ id: "m1", role: "assistant", text: "done" }],
          activity: [item({ label: "Looking up an order" })],
        })}
      />,
    );
    expect(screen.getByText("Looking up an order")).toBeDefined();
    expect(screen.getByText("done")).toBeDefined();
  });
});
