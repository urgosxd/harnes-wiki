import { useRef, type RefObject } from "react";
import type { ChatState } from "../lib/chat-reducer.ts";
import { useStickToBottom } from "../lib/stick-to-bottom.ts";
import { ActivityList } from "./ActivityList.tsx";
import { Markdown } from "./Markdown.tsx";

export interface MessageListProps {
  state: ChatState;
  /**
   * The scrolling container that holds this transcript. The list needs it to
   * tell a reader who is following the answer from one who scrolled up to read.
   */
  scrollRef: RefObject<HTMLElement | null>;
}

/**
 * The transcript as the user sees it.
 *
 * An assistant answer is formatted content: it goes through `Markdown`, which
 * composes React elements and never injects HTML, because model output is
 * untrusted input and interpreting it as markup is how a chat window becomes an
 * injection vector. A user bubble is what the reader typed, so it stays text.
 */
export function MessageList({ state, scrollRef }: MessageListProps) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const streaming = state.status === "streaming";

  // Follow the answer as it grows, but only while the reader is at the bottom:
  // scrolling on every streamed token would fight a user who scrolled up to
  // read, and a newly sent message pulls the view back so it is never off-screen.
  useStickToBottom(scrollRef, endRef, {
    streaming,
    contentKey: state.streamingText,
    // The pending bubble is a message the reader just sent: count it, or their
    // own turn could appear off-screen.
    messageCount: state.messages.length + (state.pendingUserText !== null ? 1 : 0),
  });

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
