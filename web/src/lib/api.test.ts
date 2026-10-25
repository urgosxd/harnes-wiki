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
