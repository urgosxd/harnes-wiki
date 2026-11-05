import type { Message } from "./api.ts";

/** What the chat window can be doing. Errors are states, not exceptions. */
export type ChatStatus = "idle" | "streaming" | "error";

/** One thing the assistant is doing, shown while the turn runs. */
export interface ActivityItem {
  id: string;
  kind: "thinking" | "tool" | "skill";
  /** Readable label, already user-facing. */
  label: string;
  /**
   * The tool identifier exactly as the server reported it, set only for
   * `kind: "tool"` items. It is shown verbatim beside the readable label so the
   * row names the tool that is running instead of a generic phrase. Never
   * fabricated: `tool` items created without one simply render no identifier.
   */
  tool?: string;
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
  /**
   * Which Stack a tool call actually ran on, when it was not the Stack the session was
   * opened with.
   *
   * The server words the sentence and this only carries it: it names both Stacks, so a
   * person can see that a foreign Stack was read in this turn. It outlives the reload
   * that ends the turn — `loaded` keeps it — because a remark that vanished when the
   * answer arrived would be no more visible than the log record it replaces. It belongs
   * to one turn: the next `send`, or another conversation, clears it.
   */
  stackNotices: StackNotice[];
  runId: string | null;
}

/**
 * One divergent Stack, in the words the server chose, stamped with the conversation
 * whose turn produced it.
 *
 * The stamp is what keeps a late frame out of the wrong thread. `openConversation`
 * aborts the previous run and resets the state, but a read that was already in flight
 * can still deliver frames afterwards; `loaded` now keeps notices, so an unstamped
 * sentence about a call made in conversation A could appear in conversation B — a claim
 * about a turn that never happened there. The conversation id therefore travels with
 * the sentence, and the window paints only the notices of the thread it is showing
 * (`stackNoticesFor`).
 *
 * The tool travels with it too: the dedupe is keyed on (conversation, tool, sentence),
 * so two calls that left the session's Stack are two facts even when they went to the
 * same foreign Stack. The server's sentence names the tool as well; the key is kept
 * separate so the rule does not depend on the wording staying that way.
 */
export interface StackNotice {
  /** The conversation the turn ran in. Only that thread may show the sentence. */
  conversationId: string;
  /** The tool whose call diverged: part of the identity of the fact. */
  tool: string;
  /** The server's sentence, shown verbatim. */
  text: string;
}

export const initialChatState: ChatState = {
  messages: [],
  status: "idle",
  streamingText: "",
  activity: [],
  pendingUserText: null,
  error: null,
  canRetry: false,
  stackNotices: [],
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
  | { type: "stack_notice"; conversationId: string; tool: string; text: string }
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
      // The Stack notice is kept: this reload happens the instant a turn ends, and the
      // sentence has to survive it to be seen at all.
      return { ...initialChatState, messages: action.messages, stackNotices: state.stackNotices };

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
        // A notice describes the turn it arrived in, so the next turn starts clean.
        stackNotices: [],
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
            id: `tool-${action.tool}-${state.activity.length}`,
            kind: "tool",
            label: action.label,
            // The label is what the server humanised; the identifier is what the
            // row shows beside it, so an unknown tool is still named.
            tool: action.tool,
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

    case "stack_notice": {
      // One sentence per fact: the same call reported twice must not stack up on screen.
      // The conversation and the tool are part of the fact — the same words in two
      // threads are two different turns, and two tools that each left the session's
      // Stack for the same foreign one are two different calls.
      const duplicate = state.stackNotices.some(
        (notice) =>
          notice.conversationId === action.conversationId &&
          notice.tool === action.tool &&
          notice.text === action.text,
      );
      if (duplicate) return state;
      return {
        ...state,
        stackNotices: [
          ...state.stackNotices,
          { conversationId: action.conversationId, tool: action.tool, text: action.text },
        ],
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

/**
 * The notices to paint for the conversation on screen.
 *
 * It takes the id the window is actually displaying — `useChat`'s `activeId`, the same
 * value the thread was loaded with — because that is the only authority on which
 * conversation the person is looking at. A notice stamped with any other conversation
 * belongs to a turn that is no longer displayed and is not shown; with no conversation
 * on screen there is nothing to attribute and nothing is shown either.
 */
export function stackNoticesFor(state: ChatState, conversationId: string | null): string[] {
  if (conversationId === null) return [];
  return state.stackNotices
    .filter((notice) => notice.conversationId === conversationId)
    .map((notice) => notice.text);
}
