import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { stackNoticesFor, type ChatState } from "../lib/chat-reducer.ts";
import { useStickToBottom } from "../lib/stick-to-bottom.ts";
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
  // The transcript's scroll container, and the sentinel at the end of it. Owning both
  // here, rather than in the list that renders the messages, lets the window tell a
  // reader following the answer from one who scrolled up to read — and keeps that
  // decision beside the layout around it.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const streaming = state.status === "streaming";
  const empty = state.messages.length === 0 && state.pendingUserText === null && !loadingThread;
  // Follow the answer as it grows, but only while the reader is at the bottom:
  // scrolling on every streamed token would fight a user who scrolled up to
  // read, and a message they sent pulls the view back so it is never off-screen.
  // Opening a conversation is the other deliberate move: it lands at the end.
  //
  // `sentCount` counts turns the READER sent: one per user message plus the draft
  // bubble while it waits for its reply. It must not be the transcript length,
  // which also grows when a finished turn is committed (the draft turns into a
  // user message and the answer is appended) and would therefore move a reader
  // who had scrolled up at the exact moment the answer ends. The arithmetic, per
  // step of a real turn:
  //   send        pending appears                      1 -> 2  (re-pins)
  //   token       nothing relevant changes             2 -> 2  (follows only if pinned)
  //   finished    pending -1, one user message +1      2 -> 2  (cannot move the reader)
  //   second turn pending appears again                2 -> 3  (re-pins)
  // The reducer only ever appends a user message together with clearing the
  // draft, so those two always cancel out. Loading a stored conversation does
  // grow this count, which is wanted: the transcript lands at its end.
  const { atBottom, hasNews, jumpToLatest } = useStickToBottom(scrollRef, endRef, {
    streaming,
    contentKey: state.streamingText,
    // `Message.role` is only ever "user" or "assistant" (see `api.ts`), so one
    // comparison covers every role the transcript can hold.
    sentCount:
      state.messages.filter((message) => message.role === "user").length +
      (state.pendingUserText !== null ? 1 : 0),
    conversationId,
    loadingThread,
  });

  // A reader who scrolled up gets one way back to the last message, and only while it
  // would do something: at the bottom, or over a thread with nothing in it or still
  // loading, there is no jump to offer and a permanent button is noise.
  const showJumpToLatest = !atBottom && !loadingThread && !empty;

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

      <div className="chat__transcript">
        <div className="chat__scroll" ref={scrollRef}>
          {loadingThread ? (
            <p className="chat__hint">Loading conversation…</p>
          ) : empty ? (
            <p className="chat__hint">Ask anything to start.</p>
          ) : (
            <MessageList state={state} endRef={endRef} />
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

        {/*
          The way back to the last message, over the transcript it belongs to.

          Outside the scrolling element, so it stays put while the reader moves through
          the history. Its accessible name is the words, not the glyph: the arrow is
          aria-hidden and "Jump to latest message" is what a screen reader announces and
          what the person reads. When something arrived while they were away it says so
          in the same control instead of a second badge nobody would connect to a place.
        */}
        {showJumpToLatest && (
          <button
            type="button"
            className="chat__jump"
            onClick={jumpToLatest}
            data-new={hasNews ? "true" : undefined}
          >
            <span className="chat__jump-arrow" aria-hidden="true">
              ↓
            </span>
            <span className="chat__jump-text">Jump to latest message</span>
            {hasNews && <span className="chat__jump-new">New</span>}
          </button>
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
