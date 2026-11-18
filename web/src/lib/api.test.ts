import { describe, it, expect, vi } from "vitest";
import { ApiClient, ApiError, newIdempotencyKey, titleFromMessage } from "./api.ts";

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function client(fetchImpl: typeof fetch) {
  return new ApiClient({
    baseUrl: "/api",
    headers: () => ({ "x-dev-token": "t", "x-user-id": "u" }),
    fetchImpl,
  });
}

describe("runTurn", () => {
  it("yields frames as they arrive", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        'data: {"type":"run_started","runId":"r1"}\n\n',
        'data: {"type":"text_delta","delta":"He"}\n\n',
        'data: {"type":"text_delta","delta":"llo"}\n\n',
        'data: {"type":"run_finished","outcome":"ok"}\n\n',
      ]),
    );

    const frames = [];
    for await (const frame of client(fetchMock as unknown as typeof fetch).runTurn({
      conversationId: "c1",
      message: "hi",
      idempotencyKey: "key-1",
    })) {
      frames.push(frame);
    }

    expect(frames).toEqual([
      { type: "run_started", runId: "r1" },
      { type: "text_delta", delta: "He" },
      { type: "text_delta", delta: "llo" },
      { type: "run_finished", outcome: "ok" },
    ]);
  });

  it("sends the idempotency key as a header", async () => {
    const fetchMock = vi.fn(async () => sseResponse([]));
    for await (const _frame of client(fetchMock as unknown as typeof fetch).runTurn({
      conversationId: "c1",
      message: "hi",
      idempotencyKey: "my-key",
    })) {
      // drain
    }

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBe("my-key");
    expect(JSON.parse(init.body as string)).toEqual({ message: "hi" });
  });

  it("survives a frame split across chunks", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse(['data: {"type":"text_del', 'ta","delta":"split"}\n\n']),
    );

    const frames = [];
    for await (const frame of client(fetchMock as unknown as typeof fetch).runTurn({
      conversationId: "c1",
      message: "hi",
      idempotencyKey: "k",
    })) {
      frames.push(frame);
    }

    expect(frames).toEqual([{ type: "text_delta", delta: "split" }]);
  });

  it("skips frames it does not understand instead of throwing", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        'data: {"type":"text_delta","delta":"a"}\n\n',
        'data: {"type":"future_frame","payload":1}\n\n',
        'data: {"type":"text_delta","delta":"b"}\n\n',
      ]),
    );

    const frames = [];
    for await (const frame of client(fetchMock as unknown as typeof fetch).runTurn({
      conversationId: "c1",
      message: "hi",
      idempotencyKey: "k",
    })) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(2);
  });

  it("raises a typed error for a 409 turn-in-progress", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "turn_in_progress", message: "busy" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );

    const iterate = async () => {
      for await (const _frame of client(fetchMock as unknown as typeof fetch).runTurn({
        conversationId: "c1",
        message: "hi",
        idempotencyKey: "k",
      })) {
        // drain
      }
    };

    await expect(iterate()).rejects.toBeInstanceOf(ApiError);
    await expect(iterate()).rejects.toMatchObject({ status: 409, code: "turn_in_progress" });
  });

  it("a duplicate_turn replay is an error carrying its code, not an empty answer", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "duplicate_turn", runId: "r1", message: "already used" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    // A replay answers 200 with JSON, not a stream. Silently ending would look to
    // the user like a turn that produced nothing; it must surface as a replay.
    const iterate = async () => {
      for await (const _frame of client(fetchMock as unknown as typeof fetch).runTurn({
        conversationId: "c1",
        message: "hi",
        idempotencyKey: "k",
      })) {
        // drain
      }
    };

    await expect(iterate()).rejects.toMatchObject({ code: "duplicate_turn" });
  });
});

describe("idempotency key", () => {
  it("is unique per call", () => {
    const keys = new Set(Array.from({ length: 100 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(100);
  });
});

describe("titleFromMessage", () => {
  it("collapses whitespace", () => {
    expect(titleFromMessage("  hello   world \n")).toBe("hello world");
  });

  it("keeps a short message intact", () => {
    expect(titleFromMessage("hi")).toBe("hi");
  });

  it("truncates at a word boundary", () => {
    const title = titleFromMessage("a".repeat(10) + " " + "b".repeat(100), 30);
    expect(title.length).toBeLessThanOrEqual(31);
    expect(title.endsWith("…")).toBe(true);
  });
});

/**
 * Ingest errors carry the SERVICE's own message.
 *
 * The ingest service answers `{error: {code, message}}` and our server forwards that
 * envelope unchanged, so "'not-a-stack' is not a Stack id." is available at the
 * client. Reporting only `request failed with 400` would name the status and nothing
 * the user can act on — the whole point of forwarding the envelope.
 *
 * The narrowing is deliberate: this formatter belongs to the ingest calls only. Every
 * other route keeps `errorFrom`'s copy byte-identical, which is why the fallback here
 * IS `errorFrom` rather than a second implementation of it.
 */
describe("ingest errors", () => {
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  it("surfaces the service's message and code from the forwarded envelope", async () => {
    const fetchMock = vi.fn(async () =>
      reply(400, {
        error: { code: "invalid_stack_id", message: "'not-a-stack' is not a Stack id." },
      }),
    );
    const api = client(fetchMock as unknown as typeof fetch);

    await expect(
      api.startIngest("https://example.com/a", { compile: true, stackId: "not-a-stack" }),
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_stack_id",
      message: "'not-a-stack' is not a Stack id.",
    });
  });

  it("reads the envelope on a read route too, not only on create", async () => {
    const fetchMock = vi.fn(async () =>
      reply(404, { error: { code: "stack_not_found", message: "no Stack 'x' exists." } }),
    );
    const api = client(fetchMock as unknown as typeof fetch);

    await expect(api.listIngestJobs("x")).rejects.toMatchObject({
      status: 404,
      message: "no Stack 'x' exists.",
    });
  });

  it("leaves a body that is not that envelope to the shared formatter", async () => {
    // Chat routes answer `{error: "code", message: "..."}`. Delegating keeps their
    // copy unchanged by construction rather than by inspection.
    const fetchMock = vi.fn(async () => reply(400, { error: "invalid_message", message: "message is required" }));
    const api = client(fetchMock as unknown as typeof fetch);

    await expect(api.startIngest("", { stackId: "s" })).rejects.toMatchObject({
      status: 400,
      code: "invalid_message",
      message: "message is required",
    });
  });

  it("keeps the status-only message when the body carries none", async () => {
    const fetchMock = vi.fn(async () => reply(400, { error: "bad_request" }));
    const api = client(fetchMock as unknown as typeof fetch);

    await expect(api.startIngest("https://example.com/a", { stackId: "s" })).rejects.toMatchObject({
      status: 400,
      code: "bad_request",
      message: "request failed with 400",
    });
  });
});

/**
 * WHY THESE ASSERTIONS
 *
 * The Stack list is the only thing that lets the ingest surface offer a choice
 * instead of accepting whatever the link named. Two properties matter beyond the
 * happy path: it must be a plain `GET /stacks` through the shared transport (so base
 * URL, headers and error mapping behave like every other read), and a body without a
 * `stackIds` array must read as "no choices" rather than throw — an optional field is
 * a shape the server is allowed to omit, and a panel with an empty select is better
 * than a view that dies on a 200 it did not expect.
 */
describe("listStackIds", () => {
  const reply = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  it("reads GET /stacks and returns the ids", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      reply({ stackIds: ["a", "b"] }),
    );
    const api = client(fetchMock as unknown as typeof fetch);

    await expect(api.listStackIds()).resolves.toEqual(["a", "b"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/stacks");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)["x-dev-token"]).toBe("t");
    expect((init.headers as Record<string, string>)["x-user-id"]).toBe("u");
  });

  it("returns an empty list for a body without the field", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => reply({}));
    const api = client(fetchMock as unknown as typeof fetch);

    await expect(api.listStackIds()).resolves.toEqual([]);
  });

  it("returns an empty list when the field is not an array", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      reply({ stackIds: "a" }),
    );
    const api = client(fetchMock as unknown as typeof fetch);

    await expect(api.listStackIds()).resolves.toEqual([]);
  });
});

/**
 * WHY THESE ASSERTIONS
 *
 * The two operator controls are a DELETE and a POST/retry, and both travel to a
 * tenant: `stackId` goes in the QUERY, exactly like the reads next door, because the
 * service scopes by Stack and a body would be a second place to get it wrong. The
 * three facts that can break silently are therefore: the method, the path, and the
 * presence or absence of `?stackId=` — a default here would send the request into
 * whichever tenant the endpoint is bound to.
 *
 * The refusal is the other half. A `409` from these routes is the host's ANSWER, not a
 * transport failure (`job_still_working`, `job_changed`), so it has to arrive with the
 * service's own code and words, the way every other ingest call reports errors — not
 * as `request failed with 409`.
 */
/**
 * A reply for these two controls, in the same envelope shape the service uses.
 *
 * Defined here rather than reused from the block above: that helper belongs to the
 * `ingest errors` describe and is scoped to it.
 */
function jsonReply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("deleteIngestJob", () => {
  it("issues DELETE /ingest/jobs/:id with the Stack in the query", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const api = client(fetchMock as unknown as typeof fetch);

    await api.deleteIngestJob("ing_1", "A");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/ingest/jobs/ing_1?stackId=A");
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)["x-user-id"]).toBe("u");
  });

  it("sends no query at all when no Stack is given", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(null, { status: 204 }),
    );
    const api = client(fetchMock as unknown as typeof fetch);

    await api.deleteIngestJob("ing_1");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/ingest/jobs/ing_1");
    // A blank Stack is not a Stack called "": it is no Stack.
    await api.deleteIngestJob("ing_1", "   ");
    expect((fetchMock.mock.calls[1] as [string, RequestInit])[0]).toBe("/api/ingest/jobs/ing_1");
  });

  it("survives a 204, which carries no body", async () => {
    // The server forwards the upstream 204 and sends no content-length. Reading a body
    // here would turn a SUCCESS into a parse error, which is why this path never parses.
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(null, { status: 204 }),
    );
    const api = client(fetchMock as unknown as typeof fetch);

    await expect(api.deleteIngestJob("ing_1", "A")).resolves.toBeUndefined();
  });

  it("also resolves on a 200 and a 202 that do carry a body", async () => {
    for (const status of [200, 202]) {
      const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
        jsonReply(status, { deleted: "ing_1" }),
      );
      const api = client(fetchMock as unknown as typeof fetch);
      await expect(api.deleteIngestJob("ing_1", "A")).resolves.toBeUndefined();
    }
  });

  it("maps a 409 to the service's own code and message", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonReply(409, {
        error: { code: "job_still_working", message: "job ing_1 is still working; it was not deleted." },
      }),
    );
    const api = client(fetchMock as unknown as typeof fetch);

    await expect(api.deleteIngestJob("ing_1", "A")).rejects.toMatchObject({
      status: 409,
      code: "job_still_working",
      message: "job ing_1 is still working; it was not deleted.",
    });
  });
});

describe("retryIngestJob", () => {
  it("issues POST /ingest/jobs/:id/retry with the Stack in the query", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonReply(202, { jobId: "ing_2" }),
    );
    const api = client(fetchMock as unknown as typeof fetch);

    await expect(api.retryIngestJob("ing_1", "A")).resolves.toBe("ing_2");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/ingest/jobs/ing_1/retry?stackId=A");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-user-id"]).toBe("u");
  });

  it("sends no query at all when no Stack is given", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonReply(202, { jobId: "ing_2" }),
    );
    const api = client(fetchMock as unknown as typeof fetch);

    await api.retryIngestJob("ing_1");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/ingest/jobs/ing_1/retry");
  });

  it("reads the new id from `id` when that is the field the body uses", async () => {
    // The contract allows either field; guessing one of them would leave the caller
    // following a job that does not exist.
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonReply(202, { id: "ing_3" }),
    );
    const api = client(fetchMock as unknown as typeof fetch);

    await expect(api.retryIngestJob("ing_1", "A")).resolves.toBe("ing_3");
  });

  it("treats a BLANK `jobId` as absent and reads `id` instead", async () => {
    // The same rule the server implements (`newJobId`): strings only, blank is absent.
    // Both halves have to read one body identically, or the panel follows a job the
    // server never minted.
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonReply(202, { jobId: "   ", id: "ing_x" }),
    );
    const api = client(fetchMock as unknown as typeof fetch);

    await expect(api.retryIngestJob("ing_1", "A")).resolves.toBe("ing_x");
  });

  it("treats a non-string `jobId` as absent too", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonReply(202, { jobId: 7, id: "ing_y" }),
    );
    const api = client(fetchMock as unknown as typeof fetch);

    await expect(api.retryIngestJob("ing_1", "A")).resolves.toBe("ing_y");
  });

  it("answers null when the body names no new job", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonReply(200, { ok: true }));
    const api = client(fetchMock as unknown as typeof fetch);

    await expect(api.retryIngestJob("ing_1", "A")).resolves.toBeNull();
  });

  it("maps a 409 to the service's own code and message", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonReply(409, {
        error: { code: "job_changed", message: "job ing_1 changed since it was read." },
      }),
    );
    const api = client(fetchMock as unknown as typeof fetch);

    await expect(api.retryIngestJob("ing_1", "A")).rejects.toMatchObject({
      status: 409,
      code: "job_changed",
      message: "job ing_1 changed since it was read.",
    });
  });
});
