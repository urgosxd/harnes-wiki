import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  ApiClient,
  ApiError,
  newIdempotencyKey,
  titleFromMessage,
  type Conversation,
} from "./api.ts";
import { chatReducer, initialChatState } from "./chat-reducer.ts";

export interface UseChatOptions {
  client: ApiClient;
}

/**
 * Owns the conversation list and the active thread.
 *
 * The idempotency key for a turn is created once and kept across retries: a retry
 * must resend the SAME key, otherwise the server cannot tell a retry from a second
 * turn and the transcript gains a duplicate.
 */
export function useChat({ client }: UseChatOptions) {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingThread, setLoadingThread] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const idempotencyRef = useRef<string | null>(null);
  const lastUserTextRef = useRef<string | null>(null);

  const refreshConversations = useCallback(async () => {
    try {
      const list = await client.listConversations();
      setConversations(list);
      setListError(null);
    } catch (error) {
      setListError(messageOf(error));
    } finally {
      setLoadingList(false);
    }
  }, [client]);

  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  const openConversation = useCallback(
    async (id: string) => {
      abortRef.current?.abort();
      setActiveId(id);
      setLoadingThread(true);
      dispatch({ type: "reset" });
      try {
        const detail = await client.getConversation(id);
        dispatch({ type: "loaded", messages: detail.messages });
      } catch (error) {
        dispatch({ type: "failed", message: messageOf(error), retryable: false });
      } finally {
        setLoadingThread(false);
      }
    },
    [client],
  );

  const newConversation = useCallback(() => {
    abortRef.current?.abort();
    setActiveId(null);
    dispatch({ type: "reset" });
  }, []);

  /** Send a turn. `retryOf` reuses the previous key and text. */
  const send = useCallback(
    async (text: string, options: { retry?: boolean } = {}) => {
      const trimmed = text.trim();
      if (!trimmed || state.status === "streaming") return;

      let conversationId = activeId;
      let createdTitle: string | null = null;

      // The conversation is created lazily, on the first message, so an empty
      // "new chat" never leaves a blank row in the sidebar.
      if (!conversationId) {
        try {
          const created = await client.createConversation(titleFromMessage(trimmed));
          conversationId = created.id;
          createdTitle = created.title;
          setActiveId(created.id);
        } catch (error) {
          dispatch({ type: "failed", message: messageOf(error), retryable: true });
          return;
        }
      }

      const key = options.retry && idempotencyRef.current ? idempotencyRef.current : newIdempotencyKey();
      idempotencyRef.current = key;
      lastUserTextRef.current = trimmed;

      dispatch({ type: "send", text: trimmed });

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        for await (const frame of client.runTurn({
          conversationId,
          message: trimmed,
          idempotencyKey: key,
          signal: controller.signal,
        })) {
          switch (frame.type) {
            case "run_started":
              dispatch({ type: "run_started", runId: frame.runId });
              break;
            case "text_delta":
              dispatch({ type: "delta", delta: frame.delta });
              break;
            case "tool_started":
            case "tool_finished":
              dispatch({ type: "tool", tool: frame.tool });
              break;
            case "run_finished":
              dispatch({ type: "finished", outcome: frame.outcome });
              break;
            case "run_failed":
              dispatch({ type: "failed", message: frame.message, retryable: true });
              break;
            default:
              break;
          }
        }

        // The turn is over: the key must not be reused for the next message.
        idempotencyRef.current = null;
        await refreshConversations();

        // Reload from the server so the client's rendering and the stored
        // transcript cannot drift apart.
        if (conversationId === activeId || createdTitle !== null) {
          const detail = await client.getConversation(conversationId);
          dispatch({ type: "loaded", messages: detail.messages });
        }
      } catch (error) {
        if (isAbort(error)) {
          dispatch({ type: "finished", outcome: "aborted" });
          return;
        }
        // A duplicate_turn means the server already has this turn: refreshing is
        // the right response, and retrying would be wrong.
        if (error instanceof ApiError && error.code === "duplicate_turn") {
          await refreshConversations();
          const detail = await client.getConversation(conversationId);
          dispatch({ type: "loaded", messages: detail.messages });
          return;
        }
        dispatch({ type: "failed", message: messageOf(error), retryable: true });
      } finally {
        abortRef.current = null;
      }
    },
    [activeId, client, refreshConversations, state.status],
  );

  const retry = useCallback(() => {
    const text = lastUserTextRef.current;
    if (text) void send(text, { retry: true });
  }, [send]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const remove = useCallback(
    async (id: string) => {
      try {
        await client.deleteConversation(id);
        if (id === activeId) newConversation();
        await refreshConversations();
      } catch (error) {
        setListError(messageOf(error));
      }
    },
    [activeId, client, newConversation, refreshConversations],
  );

  return {
    state,
    conversations,
    activeId,
    listError,
    loadingList,
    loadingThread,
    send,
    retry,
    stop,
    remove,
    openConversation,
    newConversation,
    refreshConversations,
  };
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Your session expired. Reload the page and sign in again.";
    if (error.status === 409) return "This conversation is still answering. Wait for it to finish.";
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"));
}
