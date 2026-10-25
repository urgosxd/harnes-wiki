import { SseParser, parseChatFrame, type ChatFrame } from "./sse.ts";

export interface Conversation {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface ConversationDetail extends Conversation {
  messages: Message[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface ApiClientOptions {
  baseUrl?: string;
  /** Returns the auth headers for a request. Kept as a function so a rotated
   *  token is picked up without rebuilding the client. */
  headers: () => Record<string, string>;
  fetchImpl?: typeof fetch;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly headers: () => Record<string, string>;
  private readonly doFetch: typeof fetch;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl ?? "/api";
    this.headers = options.headers;
    this.doFetch = options.fetchImpl ?? fetch.bind(globalThis);
  }

  async listConversations(): Promise<Conversation[]> {
    const body = await this.json<{ conversations: Conversation[] }>("GET", "/conversations");
    return body.conversations;
  }

  async createConversation(title?: string): Promise<Conversation> {
    return this.json<Conversation>("POST", "/conversations", title ? { title } : {});
  }

  async getConversation(id: string): Promise<ConversationDetail> {
    return this.json<ConversationDetail>("GET", `/conversations/${encodeURIComponent(id)}`);
  }

  async renameConversation(id: string, title: string): Promise<Conversation> {
    return this.json<Conversation>("PATCH", `/conversations/${encodeURIComponent(id)}`, { title });
  }

  async deleteConversation(id: string): Promise<void> {
    await this.request("DELETE", `/conversations/${encodeURIComponent(id)}`);
  }

  /**
   * Run a turn and iterate its frames.
   *
   * The idempotency key is what makes a reconnect safe: sending the same turn
   * again with the same key returns the original run instead of starting a second
   * one, so a dropped connection cannot duplicate a message. The caller must
   * treat a `duplicate_turn` error as "already sent", not as "retry now".
   */
  async *runTurn(input: {
    conversationId: string;
    message: string;
    idempotencyKey: string;
    signal?: AbortSignal;
  }): AsyncGenerator<ChatFrame, void, void> {
    const response = await this.doFetch(
      `${this.baseUrl}/conversations/${encodeURIComponent(input.conversationId)}/turns`,
      {
        method: "POST",
        headers: {
          ...this.headers(),
          "content-type": "application/json",
          "idempotency-key": input.idempotencyKey,
        },
        body: JSON.stringify({ message: input.message }),
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );

    if (!response.ok) {
      throw await this.errorFrom(response);
    }

    // A replay answers 200 with JSON (`duplicate_turn`) instead of a stream. Reading
    // that as SSE would find no frames and look like an empty answer, so the
    // content type decides: only an event-stream body is iterated.
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        runId?: string;
        message?: string;
      };
      throw new ApiError(
        response.status,
        body.error ?? "not_a_stream",
        body.message ?? "the server did not start a new turn",
      );
    }

    if (!response.body) {
      throw new ApiError(response.status, undefined, "the server sent no stream");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          const parsed = parseChatFrame(frame.data);
          // A frame this client does not understand is skipped, not fatal.
          if (parsed) yield parsed;
        }
      }
    } finally {
      // Releasing the reader on an aborted turn is what actually stops the stream.
      reader.releaseLock();
    }
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const response = await this.doFetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...this.headers(),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw await this.errorFrom(response);
    return response;
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.request(method, path, body);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private async errorFrom(response: Response): Promise<ApiError> {
    let code: string | undefined;
    let message = `request failed with ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string; message?: string };
      code = body.error;
      if (body.message) message = body.message;
    } catch {
      // A non-JSON error body is still an error; keep the status-based message.
    }
    return new ApiError(response.status, code, message);
  }
}

/**
 * A stable idempotency key for one user action.
 *
 * Generated when the user hits send and reused for every retry of that same
 * action, which is what lets a retry be safe. A new key per attempt would defeat
 * the whole mechanism.
 */
export function newIdempotencyKey(): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return random;
  return `k-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Derive a conversation title from its first message, as chat products do. */
export function titleFromMessage(message: string, max = 60): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  const cut = collapsed.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
