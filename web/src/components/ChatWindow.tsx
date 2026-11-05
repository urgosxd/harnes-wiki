import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { stackNoticesFor, type ChatState } from "../lib/chat-reducer.ts";
import { MessageList } from "./MessageList.tsx";

export interface ChatWindowProps {
  state: ChatState;
  /**
   * The conversation on screen, or `null` before one exists.
   *
   * The Stack notice is about one turn in one conversation, so the window is told which
   * thread it is showing and paints only that thread's notices: a frame still draining
   * from the run the user just left must not write a claim into this thread.
   */
  conversationId: string | null;
  loadingThread: boolean;
  onSend(text: string): void;
  onRetry(): void;
  onStop(): void;
  onOpenSidebar(): void;
}

export function ChatWindow({
  state,
  conversationId,
  loadingThread,
  onSend,
  onRetry,
  onStop,
  onOpenSidebar,
}: ChatWindowProps) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // The transcript's scroll container: owning it here lets the message list tell
  // a reader following the answer from one who scrolled up to read.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const streaming = state.status === "streaming";
  const empty = state.messages.length === 0 && state.pendingUserText === null && !loadingThread;

  // Keep the caret in the composer when the answer finishes, so the user can type
  // the next message without clicking.
  useEffect(() => {
    if (!streaming) inputRef.current?.focus();
  }, [streaming]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || streaming) return;
    onSend(text);
    setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter adds a line. An IME composition must not submit.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <main className="chat">
      <header className="chat__header">
        <button
          type="button"
          className="chat__menu"
          aria-label="Open conversations"
          onClick={onOpenSidebar}
        >
          ☰
        </button>
        <span className="chat__title">Chat</span>
      </header>

      <div className="chat__scroll" ref={scrollRef}>
        {loadingThread ? (
          <p className="chat__hint">Loading conversation…</p>
        ) : empty ? (
          <p className="chat__hint">Ask anything to start.</p>
        ) : (
          <MessageList state={state} scrollRef={scrollRef} />
        )}

        {/*
          Which Stack a tool call was actually sent to, when it was not the session's.

          Here, in the turn's own output, because the point of the sentence is that a
          person reads it: the server's log record is for an operator weeks later, and a
          tool's result text never reaches this window. Rendered outside the thread/hint
          choice above so it stays visible after the turn ends and the thread reloads,
          and filtered to the conversation on screen so a late frame from another thread
          cannot paint here. Position is the only stable key a line can have: the same
          sentence can be two different facts (two tools, one foreign Stack).
        */}
        {stackNoticesFor(state, conversationId).map((notice, position) => (
          <p key={`${position}-${notice}`} className="chat__stack-notice" role="status">
            {notice}
          </p>
        ))}

        {state.error && (
          <div className="chat__error" role="alert">
            <span>{state.error}</span>
            {state.canRetry && (
              <button type="button" className="button button--small" onClick={onRetry}>
                Retry
              </button>
            )}
          </div>
        )}
      </div>

      <form className="composer" onSubmit={submit}>
        <textarea
          ref={inputRef}
          className="composer__input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Send a message…"
          rows={1}
          aria-label="Message"
        />
        {streaming ? (
          <button type="button" className="button composer__stop" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button type="submit" className="button button--primary" disabled={draft.trim().length === 0}>
            Send
          </button>
        )}
      </form>
    </main>
  );
}
