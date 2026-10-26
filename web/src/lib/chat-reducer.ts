import type { Message } from "./api.ts";

/** What the chat window can be doing. Errors are states, not exceptions. */
export type ChatStatus = "idle" | "streaming" | "error";

/** One thing the assistant is doing, shown while the turn runs. */
export interface ActivityItem {
  id: string;
  kind: "thinking" | "tool" | "skill";
  /** Readable label, already user-facing. */
  label: string;
  /** Running tools stay visible with a spinner until they finish. */
  done: boolean;
  failed?: boolean;
}

export interface ChatState {
  messages: Message[];
  status: ChatStatus;
  /** Text of the assistant reply currently being streamed. */
  streamingText: string;
  /**
   * What the assistant is doing right now: reasoning, tool calls, skills it read.
   * Empty when nothing has been reported yet, which is when the client shows a
   * bare "working" indicator instead of inventing a step.
   */
  activity: ActivityItem[];
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
  activity: [],
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
  | { type: "thinking"; delta: string }
  | { type: "skill"; name: string }
  | { type: "tool_started"; tool: string; label: string }
  | { type: "tool_finished"; tool: string; label: string; isError: boolean }
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
        activity: [],
        pendingUserText: action.text,
        runId: null,
      };

    case "run_started":
      return { ...state, runId: action.runId };

    case "delta":
      return { ...state, streamingText: state.streamingText + action.delta };

    /**
     * Reasoning is a single evolving step, not one row per chunk: the user cares
     * that the model is thinking, not about each token of it.
     */
    case "thinking": {
      const existing = state.activity.find((item) => item.kind === "thinking");
      if (existing) {
        return {
          ...state,
          activity: state.activity.map((item) =>
            item.id === existing.id ? { ...item, label: "Thinking…" } : item,
          ),
        };
      }
      return {
        ...state,
        activity: [
          ...state.activity,
          { id: `thinking-${state.activity.length}`, kind: "thinking", label: "Thinking…", done: true },
        ],
      };
    }

    case "skill": {
      // One row per skill, and only once, however many chunks mention it. The
      // comparison is against the bare name: the label carries a verb, so
      // comparing labels would never match and every chunk would add a row.
      if (state.activity.some((item) => item.kind === "skill" && item.label === `Reading ${action.name}`)) {
        return state;
      }
      return {
        ...state,
        activity: [
          ...state.activity,
          {
            id: `skill-${state.activity.length}`,
            kind: "skill",
            label: `Reading ${action.name}`,
            done: true,
          },
        ],
      };
    }

    case "tool_started":
      return {
        ...state,
        activity: [
          ...state.activity,
          {
            // The tool id is used only as a local key; the label is what is shown.
            id: `tool-${action.tool}-${state.activity.length}`,
            kind: "tool",
            label: action.label,
            done: false,
          },
        ],
      };

    case "tool_finished": {
      // Close the oldest running call of this tool: the same tool can run twice.
      const index = state.activity.findIndex(
        (item) => item.kind === "tool" && !item.done && item.label === action.label,
      );
      if (index === -1) return state;
      return {
        ...state,
        activity: state.activity.map((item, position) =>
          position === index ? { ...item, done: true, failed: action.isError } : item,
        ),
      };
    }

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
        // The activity stays after the turn so the user can see what was done;
        // it is cleared when the next turn starts.
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
