import { useEffect, useRef } from "react";
import type { ChatState } from "../lib/chat-reducer.ts";

export interface MessageListProps {
  state: ChatState;
}

/**
 * The transcript as the user sees it.
 *
 * Text is rendered as text, never as HTML: model output is untrusted input and
 * interpreting it as markup is how a chat window becomes an injection vector.
 */
export function MessageList({ state }: MessageListProps) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const streaming = state.status === "streaming";

  // Follow the answer as it grows, but only while streaming: scrolling on every
  // render would fight a user who scrolled up to read.
  useEffect(() => {
    if (!streaming) return;
    // Optional call: a document without layout (tests, some embedded webviews)
    // has no scrollIntoView, and a missing scroller must not break the answer.
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [state.streamingText, streaming]);

  return (
    <div className="messages">
      {state.messages.map((message) => (
        <article key={message.id} className={`message message--${message.role}`}>
          <div className="message__text">{message.text}</div>
        </article>
      ))}

      {state.pendingUserText !== null && (
        <article className="message message--user">
          <div className="message__text">{state.pendingUserText}</div>
        </article>
      )}

      {streaming && (
        <article className="message message--assistant">
          {state.streamingText ? (
            <div className="message__text">
              {state.streamingText}
              <span className="caret" aria-hidden="true" />
            </div>
          ) : (
            <div className="message__thinking" aria-label="Thinking">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
            </div>
          )}
        </article>
      )}

      <div ref={endRef} />
    </div>
  );
}
