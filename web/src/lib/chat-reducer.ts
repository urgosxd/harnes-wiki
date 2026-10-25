import type { Message } from "./api.ts";

/** What the chat window can be doing. Errors are states, not exceptions. */
export type ChatStatus = "idle" | "streaming" | "error";

export interface ChatState {
  messages: Message[];
  status: ChatStatus;
  /** Text of the assistant reply currently being streamed. */
  streamingText: string;
  /** The user's message waiting for a reply, shown as a bubble immediately. */
  pendingUserText: string | null;
  /** Human-readable failure, when status is "error". */
  error: string | null;
  /** True when the last failure is worth retrying. */
  canRetry: boolean;
  runId: string | null;
}

export const initialChatState: ChatState = {
  messages: [],
  status: "idle",
  streamingText: "",
  pendingUserText: null,
  error: null,
  canRetry: false,
  runId: null,
};

export type ChatAction =
  | { type: "loaded"; messages: Message[] }
  | { type: "send"; text: string }
  | { type: "run_started"; runId: string }
  | { type: "delta"; delta: string }
  | { type: "tool"; tool: string }
  | { type: "finished"; outcome: string }
  | { type: "failed"; message: string; retryable: boolean }
  | { type: "reset" };

/**
 * The chat window's state machine.
 *
 * Kept as a pure reducer so the hard cases (a stream that fails halfway, a reply
 * that arrives after a reload) can be tested without a browser.
 */
export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "loaded":
      return { ...initialChatState, messages: action.messages };

    case "send":
      // The user bubble appears before the server answers, so the UI never looks
      // frozen while the model thinks.
      return {
        ...state,
        status: "streaming",
        error: null,
        canRetry: false,
        streamingText: "",
        pendingUserText: action.text,
        runId: null,
      };

    case "run_started":
      return { ...state, runId: action.runId };

    case "delta":
      return { ...state, streamingText: state.streamingText + action.delta };

    case "tool":
      return state;

    case "finished": {
      const assistantText = state.streamingText;
      const messages = [...state.messages];

      // The user's turn is committed only once the run produced something.
      if (state.pendingUserText !== null) {
        messages.push({
          id: `local-u-${messages.length}`,
          role: "user",
          text: state.pendingUserText,
        });
      }
      if (assistantText.trim().length > 0) {
        messages.push({
          id: `local-a-${messages.length}`,
          role: "assistant",
          text: assistantText,
        });
      }

      return {
        ...state,
        messages,
        status: "idle",
        streamingText: "",
        pendingUserText: null,
        runId: null,
        canRetry: false,
        error:
          action.outcome === "aborted"
            ? "Stopped."
            : action.outcome === "length"
              ? "The answer was cut off because it reached the length limit."
              : null,
      };
    }

    case "failed":
      // The user's text is kept so a retry can resend exactly the same turn, and
      // the partial reply is kept so a truncated answer is not silently lost.
      return {
        ...state,
        status: "error",
        error: action.message,
        canRetry: action.retryable,
      };

    case "reset":
      return { ...initialChatState };

    default:
      return state;
  }
}
