import { SseParser, parseChatFrame, type ChatFrame } from "./sse.ts";
import { pollJob, type IngestJob, type IngestJobAccepted, type PollOutcome } from "./ingest.ts";

/**
 * A document this user uploaded.
 *
 * Deliberately no `url` and no `secret`: the listing must never hand out the
 * capability, and the bytes are reached by the ingest service, not by the browser.
 */
export interface UploadedDocument {
  id: string;
  filename: string;
  bytes: number;
  contentType: string;
  createdAt: string;
}

export interface Identity {
  id: string;
  displayName: string;
}

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
  /** Called once when the server rejects the credentials, so the UI can ask for
   *  them again instead of showing an empty screen. */
  onUnauthorized?: () => void;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly headers: () => Record<string, string>;
  private readonly doFetch: typeof fetch;
  private readonly onUnauthorized: (() => void) | undefined;
  private unauthorizedReported = false;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl ?? "/api";
    this.headers = options.headers;
    this.doFetch = options.fetchImpl ?? fetch.bind(globalThis);
    this.onUnauthorized = options.onUnauthorized;
  }

  /** Announce a rejected credential once; repeated 401s must not re-prompt. */
  private reportUnauthorized(): void {
    if (this.unauthorizedReported) return;
    this.unauthorizedReported = true;
    this.onUnauthorized?.();
  }

  /** Who these credentials belong to. Proves a link carried a real secret. */
  async me(): Promise<Identity> {
    return this.json<Identity>("GET", "/me");
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

  // -------------------------------------------------------------------------
  // Ingest jobs
  // -------------------------------------------------------------------------

  /**
   * Start an async ingest and return the job identity.
   *
   * The server forces `async: true`, so this can never turn into a request that
   * blocks for minutes. `compile: false` verifies the source without compiling.
   */
  async startIngest(
    source: string,
    options: { compile?: boolean; stackId?: string | undefined } = {},
  ): Promise<IngestJobAccepted> {
    return this.json<IngestJobAccepted>("POST", "/ingest/jobs", {
      source,
      compile: options.compile !== false,
      // The Stack the job belongs to. Omitted means the endpoint's own, which this
      // product no longer trusts as a default - see the picker guard in stacks.ts.
      ...(options.stackId ? { stackId: options.stackId } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------

  /**
   * Upload one document and keep its identity.
   *
   * The filename travels as a query parameter, not in a header, because the ingest
   * service routes by FILE EXTENSION: the name decides whether the bytes are parsed
   * as a PDF, an image or a web page. A header would not survive into the URL the
   * service fetches.
   *
   * The body is the raw file. `content-type` is the file's own, so the stored
   * document carries the type it actually had.
   */
  async uploadDocument(file: File): Promise<UploadedDocument> {
    return this.json<UploadedDocument>(
      "POST",
      `/documents?filename=${encodeURIComponent(file.name)}`,
      file,
      { "content-type": file.type || "application/octet-stream" },
    );
  }

  async listDocuments(): Promise<UploadedDocument[]> {
    const body = await this.json<{ documents?: UploadedDocument[] }>("GET", "/documents");
    return body.documents ?? [];
  }

  async deleteDocument(id: string): Promise<void> {
    await this.request("DELETE", `/documents/${encodeURIComponent(id)}`);
  }

  /** Start an ingest for an uploaded document, by reference rather than by path. */
  async startIngestForDocument(
    documentId: string,
    options: { compile?: boolean; stackId?: string | undefined } = {},
  ): Promise<IngestJobAccepted> {
    return this.json<IngestJobAccepted>("POST", "/ingest/jobs", {
      documentId,
      compile: options.compile !== false,
      ...(options.stackId ? { stackId: options.stackId } : {}),
    });
  }

  async listIngestJobs(stackId?: string): Promise<IngestJob[]> {
    const body = await this.json<{ jobs?: IngestJob[] }>("GET", `/ingest/jobs${stackQuery(stackId)}`);
    return body.jobs ?? [];
  }

  async getIngestJob(id: string, stackId?: string): Promise<IngestJob> {
    return this.json<IngestJob>(
      "GET",
      `/ingest/jobs/${encodeURIComponent(id)}${stackQuery(stackId)}`,
    );
  }

  /**
   * Follow a job until both dimensions settle.
   *
   * Stops are outcomes, not exceptions: a 503 (host without job tracking) and a
   * 404 (job expired) are different facts and both are reported as such.
   */
  pollIngestJob(
    id: string,
    options: {
      onUpdate: (job: IngestJob) => void;
      /** Which Stack to read, when it is not the endpoint's own. */
      stackId?: string;
      signal?: AbortSignal;
      fetchImpl?: typeof fetch;
      sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    },
  ): Promise<PollOutcome> {
    return pollJob(id, {
      baseUrl: this.baseUrl,
      ...(options.stackId ? { stackId: options.stackId } : {}),
      headers: this.headers,
      onUpdate: options.onUpdate,
      // The client's own transport, so a poll goes wherever every other call
      // goes. Falling back to global `fetch` here would silently bypass an
      // injected transport and talk to a different origin than the rest of the
      // client.
      fetchImpl: options.fetchImpl ?? this.doFetch,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
    });
  }

  /**
   * One request.
   *
   * `rawBody` exists for uploads: a File must be sent as bytes, not JSON. It is a
   * separate parameter rather than a `body: unknown` overload so that sending a
   * binary body without also setting its content type is impossible to do by
   * accident — JSON.stringify on a File would produce `{}` and a silent empty
   * upload.
   */
  private async request(
    method: string,
    path: string,
    body?: unknown,
    options: { rawBody?: BodyInit; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const hasRaw = options.rawBody !== undefined;
    const response = await this.doFetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...this.headers(),
        ...(hasRaw ? {} : body === undefined ? {} : { "content-type": "application/json" }),
        ...(options.headers ?? {}),
      },
      ...(hasRaw
        ? { body: options.rawBody }
        : body === undefined
          ? {}
          : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw await this.errorFrom(response);
    return response;
  }

  private async json<T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    // A File (or any BodyInit that is not plain JSON) is sent as bytes.
    const isRaw = typeof Blob !== "undefined" && body instanceof Blob;
    const response = await this.request(
      method,
      path,
      isRaw ? undefined : body,
      isRaw ? { rawBody: body as BodyInit, ...(headers ? { headers } : {}) } : headers ? { headers } : {},
    );
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private async errorFrom(response: Response): Promise<ApiError> {
    if (response.status === 401) this.reportUnauthorized();
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

/** `?stackId=` or nothing: an empty value would name a Stack called "". */
function stackQuery(stackId: string | undefined): string {
  const trimmed = stackId?.trim();
  return trimmed ? `?stackId=${encodeURIComponent(trimmed)}` : "";
}

/** Derive a conversation title from its first message, as chat products do. */
export function titleFromMessage(message: string, max = 60): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  const cut = collapsed.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
