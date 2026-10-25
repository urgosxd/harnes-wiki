import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ChatState } from "../lib/chat-reducer.ts";
import { MessageList } from "./MessageList.tsx";

export interface ChatWindowProps {
  state: ChatState;
  loadingThread: boolean;
  onSend(text: string): void;
  onRetry(): void;
  onStop(): void;
  onOpenSidebar(): void;
}

export function ChatWindow({
  state,
  loadingThread,
  onSend,
  onRetry,
  onStop,
  onOpenSidebar,
}: ChatWindowProps) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
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

      <div className="chat__scroll">
        {loadingThread ? (
          <p className="chat__hint">Loading conversation…</p>
        ) : empty ? (
          <p className="chat__hint">Ask anything to start.</p>
        ) : (
          <MessageList state={state} />
        )}

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
