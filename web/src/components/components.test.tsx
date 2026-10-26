import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Sidebar } from "./Sidebar.tsx";
import { ChatWindow } from "./ChatWindow.tsx";
import { MessageList } from "./MessageList.tsx";
import { initialChatState, type ChatState } from "../lib/chat-reducer.ts";

function state(overrides: Partial<ChatState> = {}): ChatState {
  return { ...initialChatState, ...overrides };
}

describe("Sidebar", () => {
  const base = {
    conversations: [],
    activeId: null,
    loading: false,
    error: null,
    open: false,
    onSelect: () => {},
    onNew: () => {},
    onDelete: () => {},
    onClose: () => {},
  };

  it("says so when there are no conversations", () => {
    render(<Sidebar {...base} />);
    expect(screen.getByText("No conversations yet.")).toBeDefined();
  });

  it("lists conversations by title", () => {
    render(
      <Sidebar
        {...base}
        conversations={[
          { id: "a", title: "First chat", createdAt: "", updatedAt: "" },
          { id: "b", title: null, createdAt: "", updatedAt: "" },
        ]}
      />,
    );
    expect(screen.getByText("First chat")).toBeDefined();
    expect(screen.getByText("Untitled")).toBeDefined();
  });

  it("calls onSelect with the conversation id", () => {
    const onSelect = vi.fn();
    render(
      <Sidebar
        {...base}
        onSelect={onSelect}
        conversations={[{ id: "conv-1", title: "Chat", createdAt: "", updatedAt: "" }]}
      />,
    );
    fireEvent.click(screen.getByText("Chat"));
    expect(onSelect).toHaveBeenCalledWith("conv-1");
  });

  it("deletes without selecting", () => {
    const onSelect = vi.fn();
    const onDelete = vi.fn();
    render(
      <Sidebar
        {...base}
        onSelect={onSelect}
        onDelete={onDelete}
        conversations={[{ id: "conv-1", title: "Chat", createdAt: "", updatedAt: "" }]}
      />,
    );
    fireEvent.click(screen.getByLabelText("Delete Chat"));
    expect(onDelete).toHaveBeenCalledWith("conv-1");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("starts a new chat", () => {
    const onNew = vi.fn();
    render(<Sidebar {...base} onNew={onNew} />);
    fireEvent.click(screen.getByText("New chat"));
    expect(onNew).toHaveBeenCalled();
  });
});

describe("MessageList", () => {
  it("renders stored messages", () => {
    render(
      <MessageList
        state={state({
          messages: [
            { id: "1", role: "user", text: "hello" },
            { id: "2", role: "assistant", text: "hi there" },
          ],
        })}
      />,
    );
    expect(screen.getByText("hello")).toBeDefined();
    expect(screen.getByText("hi there")).toBeDefined();
  });

  it("shows the pending user message before the reply arrives", () => {
    render(<MessageList state={state({ status: "streaming", pendingUserText: "waiting" })} />);
    expect(screen.getByText("waiting")).toBeDefined();
    // The activity list now owns the progress indicator, so the old anonymous
    // "thinking" dots are gone on purpose.
    expect(screen.getByText("Working…")).toBeDefined();
  });

  it("shows the streaming text while it grows", () => {
    render(<MessageList state={state({ status: "streaming", streamingText: "partial ans" })} />);
    expect(screen.getByText(/partial ans/)).toBeDefined();
  });

  it("renders model output as text, not as markup", () => {
    const injected = '<img src=x onerror="alert(1)">';
    render(<MessageList state={state({ messages: [{ id: "1", role: "assistant", text: injected }] })} />);
    // The tag must be visible as characters and produce no element.
    expect(screen.getByText(injected)).toBeDefined();
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("ChatWindow", () => {
  const base = {
    state: state(),
    loadingThread: false,
    onSend: () => {},
    onRetry: () => {},
    onStop: () => {},
    onOpenSidebar: () => {},
  };

  it("sends on Enter and keeps the draft on Shift+Enter", async () => {
    const onSend = vi.fn();
    render(<ChatWindow {...base} onSend={onSend} />);
    const input = screen.getByLabelText("Message");

    fireEvent.change(input, { target: { value: "first line" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("first line");
  });

  it("does not send an empty draft", () => {
    const onSend = vi.fn();
    render(<ChatWindow {...base} onSend={onSend} />);
    fireEvent.click(screen.getByText("Send"));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("offers Stop instead of Send while streaming", () => {
    const onStop = vi.fn();
    render(<ChatWindow {...base} state={state({ status: "streaming" })} onStop={onStop} />);
    expect(screen.queryByText("Send")).toBeNull();
    fireEvent.click(screen.getByText("Stop"));
    expect(onStop).toHaveBeenCalled();
  });

  it("shows an error with a retry button when the run can be retried", () => {
    const onRetry = vi.fn();
    render(
      <ChatWindow
        {...base}
        state={state({ status: "error", error: "model unavailable", canRetry: true })}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("model unavailable")).toBeDefined();
    fireEvent.click(screen.getByText("Retry"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("does not offer a retry it cannot perform", () => {
    render(
      <ChatWindow
        {...base}
        state={state({ status: "error", error: "your session expired", canRetry: false })}
      />,
    );
    expect(screen.getByText("your session expired")).toBeDefined();
    expect(screen.queryByText("Retry")).toBeNull();
  });

  it("invites the first message when the thread is empty", () => {
    render(<ChatWindow {...base} />);
    expect(screen.getByText("Ask anything to start.")).toBeDefined();
  });

  it("exposes a menu button for small screens", async () => {
    const onOpenSidebar = vi.fn();
    render(<ChatWindow {...base} onOpenSidebar={onOpenSidebar} />);
    fireEvent.click(screen.getByLabelText("Open conversations"));
    await waitFor(() => expect(onOpenSidebar).toHaveBeenCalled());
  });
});
