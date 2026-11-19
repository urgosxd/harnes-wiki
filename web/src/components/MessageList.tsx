import type { RefObject } from "react";
import type { ChatState } from "../lib/chat-reducer.ts";
import { ActivityList } from "./ActivityList.tsx";
import { Markdown } from "./Markdown.tsx";

export interface MessageListProps {
  state: ChatState;
  /**
   * The sentinel at the end of the transcript: the element the chat window moves
   * the viewport to. It is handed in because the window owns the scrolling
   * decision — it is the component that surrounds the container this list lives
   * in and that shows the control for going back to the latest message.
   */
  endRef: RefObject<HTMLDivElement | null>;
}

/**
 * The transcript as the user sees it.
 *
 * An assistant answer is formatted content: it goes through `Markdown`, which
 * composes React elements and never injects HTML, because model output is
 * untrusted input and interpreting it as markup is how a chat window becomes an
 * injection vector. A user bubble is what the reader typed, so it stays text.
 */
export function MessageList({ state, endRef }: MessageListProps) {
  const streaming = state.status === "streaming";

  return (
    <div className="messages">
      {state.messages.map((message) => (
        <article key={message.id} className={`message message--${message.role}`}>
          <div className="message__text">
            {message.role === "assistant" ? <Markdown text={message.text} /> : message.text}
          </div>
        </article>
      ))}

      {state.pendingUserText !== null && (
        <article className="message message--user">
          <div className="message__text">{state.pendingUserText}</div>
        </article>
      )}

      {(streaming || state.activity.length > 0) && (
        <ActivityList items={state.activity} streaming={streaming} />
      )}

      {streaming && (
        <article className="message message--assistant">
          {state.streamingText ? (
            <div className="message__text message__text--streaming">
              <Markdown text={state.streamingText} />
              <span className="caret" aria-hidden="true" />
            </div>
          ) : (
            // The ActivityList above already says what is happening; a second
            // "thinking" row here would be redundant.
            null
          )}
        </article>
      )}

      <div ref={endRef} />
    </div>
  );
}
