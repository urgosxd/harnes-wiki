import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App.tsx";

/**
 * The product has no sign-in surface, on any path.
 *
 * Identity is the `user` in the link, and there is no secret behind it — so a form
 * could not verify anything a person typed. These tests pin that there is nothing to
 * type, and that the three non-happy paths explain themselves instead of offering one.
 */
function useUrl(search: string) {
  window.history.replaceState(null, "", `/${search}`);
}

/** A path with no request in it, so a missing fetch is a failure rather than a hang. */
function noFetch() {
  const mock = vi.fn(async () => {
    throw new Error("no request expected on this path");
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

/**
 * No sign-in surface, and nothing that accepts a credential.
 *
 * Deliberately not "no textbox at all": once a valid link authenticates, the chat
 * window legitimately renders a composer. What must never appear is a field asking
 * for an identity, so the assertion names those fields rather than every input.
 */
function expectNoSignInForm() {
  expect(document.querySelectorAll("input")).toHaveLength(0);
  expect(screen.queryAllByLabelText(/token/i)).toHaveLength(0);
  expect(screen.queryAllByLabelText(/your name/i)).toHaveLength(0);
  expect(screen.queryAllByLabelText(/password/i)).toHaveLength(0);
  expect(screen.queryAllByText(/sign in/i)).toHaveLength(0);
  expect(screen.queryAllByText(/continue/i)).toHaveLength(0);
}

describe("App identity from the link", () => {
  beforeEach(() => {
    useUrl("?user=alice");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens the product from a link that only names a user", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: "alice", displayName: "alice" })),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    // The name alone, and no token header at all.
    expect(init.headers).toEqual({ "x-user-id": "alice" });
    expectNoSignInForm();
  });

  it("still forwards a token when an older link carries one", async () => {
    useUrl("?user=alice&token=abc123");
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: "alice", displayName: "alice" })),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toEqual({ "x-user-id": "alice", "x-dev-token": "abc123" });
    expectNoSignInForm();
  });

  it("explains a link with no user instead of offering a form", () => {
    useUrl("");
    const fetchMock = noFetch();

    render(<App />);

    expect(screen.getByText(/needs a user in the link/i)).toBeDefined();
    expectNoSignInForm();
    // Nothing was asked of the server: there is no identity to check.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not accept a token-only link as an identity", () => {
    // With no roster, a token names nobody. Guessing which account was meant would
    // be worse than saying the link is incomplete.
    useUrl("?token=abc123");
    const fetchMock = noFetch();

    render(<App />);

    expect(screen.getByText(/needs a user in the link/i)).toBeDefined();
    expectNoSignInForm();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains a refused identity instead of offering a form that cannot work", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByText(/was not accepted/i)).toBeDefined());
    expectNoSignInForm();
  });

  it("does not turn a server that is down into an identity problem", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );

    render(<App />);

    await waitFor(() => expect(screen.getByText(/cannot reach the server/i)).toBeDefined());
    expectNoSignInForm();
  });
});

/**
 * The tenant is the Stack in the link, and these four rules are the whole contract:
 *
 *  R1 — no stackId means the ingest surface is blocked and NOTHING is read.
 *  R2 — a stackId travels on the list, the poll and the create.
 *  R3 — whitespace is not a stackId, so it is blocked before any request.
 *  R4 — a Stack the server rejects is shown once, and never retried.
 */
interface RecordedCall {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
  /** Every header the client sent, so a transport rule can be asserted rather than
   *  inferred from the URL. */
  headers: Record<string, string>;
}

const ACCEPTED = {
  jobId: "ing_1",
  status: "queued",
  stage: "queued",
  ingest: { status: "queued", attempts: [] },
  compile: { status: "queued", progress: null },
};

const SETTLED = {
  id: "ing_1",
  source: "https://example.com/a",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:10.000Z",
  ingest: { status: "succeeded", attempts: [] },
  compile: { status: "succeeded", progress: null },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/**
 * A stubbed server that records every call, with the chat endpoints answered so only
 * the ingest traffic has to be described.
 */
function stubApi(routes: Array<[string, (call: RecordedCall) => Response]> = []) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const raw = typeof init.body === "string" ? init.body : null;
    const call: RecordedCall = {
      method: (init.method ?? "GET").toUpperCase(),
      url: String(input),
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
      headers: (init.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    for (const [needle, handler] of routes) {
      if (call.url.includes(needle)) return handler(call);
    }
    if (call.url.endsWith("/me")) return json({ id: "alice", displayName: "alice" });
    if (call.url.includes("/conversations")) return json({ conversations: [] });
    if (call.url.includes("/documents")) return json({ documents: [] });
    if (call.url.includes("/ingest/jobs")) return json({ jobs: [] });
    throw new Error(`unexpected request: ${call.method} ${call.url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

/** Requests that would read or write somebody's data. */
function dataReads(calls: readonly RecordedCall[]) {
  return calls.filter((call) => /\/ingest\/|\/documents/.test(call.url));
}

describe("App ingest scoping from the link", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("blocks the ingest surface and reads nothing when the link has no stackId", async () => {
    useUrl("?user=alice");
    const calls = stubApi();

    render(<App />);
    await screen.findByText("New chat");
    fireEvent.click(screen.getByText("Ingest jobs"));

    // The failure is visible and names what is missing and how the link must look.
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("stackId");
    expect(alert.textContent).toContain("?user=<name>&stackId=<stack-id>");
    // And there is no ingest surface behind it to read from.
    expect(screen.queryByLabelText("Source")).toBeNull();

    // The rule this exists for: no job list, no document list, no poll, no create.
    await waitFor(() => expect(screen.getByText("Back to chat")).toBeDefined());
    expect(dataReads(calls)).toEqual([]);
  });

  it("treats whitespace as no stackId, before any request", async () => {
    useUrl("?user=alice&stackId=%20%20");
    const calls = stubApi();

    render(<App />);
    await screen.findByText("New chat");
    fireEvent.click(screen.getByText("Ingest jobs"));

    expect(screen.getByRole("alert").textContent).toContain("stackId");
    expect(dataReads(calls)).toEqual([]);
  });

  it("carries the link's stackId on the list, the poll and the create", async () => {
    useUrl("?user=alice&stackId=0f8b1e42-1111-2222-3333-444455556666");
    const stack = "0f8b1e42-1111-2222-3333-444455556666";
    const calls = stubApi([
      [
        "/ingest/jobs",
        (call) => {
          if (call.method === "POST") return json(ACCEPTED, 202);
          if (/\/ingest\/jobs\/ing_1/.test(call.url)) return json(SETTLED);
          return json({ jobs: [] });
        },
      ],
    ]);

    render(<App />);
    await screen.findByText("New chat");

    // The list read carries it.
    await waitFor(() =>
      expect(calls.some((call) => call.url === `/api/ingest/jobs?stackId=${stack}`)).toBe(true),
    );

    fireEvent.click(screen.getByText("Ingest jobs"));
    fireEvent.change(screen.getByLabelText("Source"), {
      target: { value: "https://example.com/a" },
    });
    fireEvent.click(screen.getByText("Start ingest"));

    // The create carries it in the body...
    await waitFor(() =>
      expect(calls.some((call) => call.method === "POST" && call.url.includes("/ingest/jobs"))).toBe(
        true,
      ),
    );
    const create = calls.find(
      (call) => call.method === "POST" && call.url.includes("/ingest/jobs"),
    );
    expect(create?.body?.stackId).toBe(stack);

    // ...and so does the poll, which is the read that would otherwise leak.
    await waitFor(() =>
      expect(
        calls.some((call) => call.url === `/api/ingest/jobs/ing_1?stackId=${stack}`),
      ).toBe(true),
    );
  });

  it("shows a rejected StackId once, and does not retry it", async () => {
    useUrl("?user=alice&stackId=not-a-stack");
    const calls = stubApi([
      [
        "/ingest/jobs",
        (call) => {
          if (call.method === "POST") {
            return json({ error: { code: "invalid_stack_id", message: "'not-a-stack' is not a Stack id." } }, 400);
          }
          return json({ jobs: [] });
        },
      ],
    ]);

    render(<App />);
    await screen.findByText("New chat");
    fireEvent.click(screen.getByText("Ingest jobs"));
    fireEvent.change(screen.getByLabelText("Source"), {
      target: { value: "https://example.com/a" },
    });
    fireEvent.click(screen.getByText("Start ingest"));

    // The server's own message reaches the screen, not just its status code: a bare
    // "request failed with 400" names nothing the user can act on.
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("'not-a-stack' is not a Stack id."),
    );

    // One attempt. A rejected tenant is a fact, not something to hammer.
    const creates = calls.filter((call) => call.method === "POST" && call.url.includes("/ingest/jobs"));
    expect(creates).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls.filter((call) => call.method === "POST" && call.url.includes("/ingest/jobs"))).toHaveLength(1);
  });
});

/**
 * The turn transport carries the Stack too.
 *
 * The ingest surface already names its Stack in the URL and the body; the chat's own
 * turn POST has no such place, so the link's Stack travels as `x-stack-id`. It is a
 * SELECTION, never an authorisation: the server derives no entitlement from it, and
 * it is the only way the agent's Stack-scoped tools learn which Stack to read.
 *
 * With no Stack in the link there is nothing to send, and the header must be absent
 * rather than empty — an empty value would name a Stack called "".
 */
function chatRoutes(): Array<[string, (call: RecordedCall) => Response]> {
  return [
    [
      "/conversations",
      (call) => {
        if (call.method === "POST" && call.url.endsWith("/conversations")) {
          return json({ id: "c1", title: "hola", createdAt: "", updatedAt: "" }, 201);
        }
        if (call.url.endsWith("/conversations/c1/turns")) {
          // A turn stream that closes immediately: the test reads the request, not
          // the answer.
          return new Response('data: {"type":"run_finished","outcome":"ok"}\n\n', {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        if (call.url.endsWith("/conversations/c1")) {
          return json({ id: "c1", title: "hola", createdAt: "", updatedAt: "", messages: [] });
        }
        return json({ conversations: [] });
      },
    ],
  ];
}

function turnPost(calls: readonly RecordedCall[]): RecordedCall | undefined {
  return calls.find((call) => call.method === "POST" && call.url.endsWith("/turns"));
}

/** Open the chat, type one message and send it. */
async function sendOneMessage(): Promise<void> {
  render(<App />);
  await screen.findByText("New chat");
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hola" } });
  fireEvent.click(screen.getByText("Send"));
}

describe("App turn transport carries the link's StackId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends x-stack-id equal to the link's stackId on the turn", async () => {
    const stack = "0f8b1e42-1111-2222-3333-444455556666";
    useUrl(`?user=alice&stackId=${stack}`);
    const calls = stubApi(chatRoutes());

    await sendOneMessage();

    await waitFor(() => expect(turnPost(calls)).toBeDefined());
    expect(turnPost(calls)?.headers["x-stack-id"]).toBe(stack);
  });

  it("sends no x-stack-id at all when the link names no stackId", async () => {
    useUrl("?user=alice");
    const calls = stubApi(chatRoutes());

    await sendOneMessage();

    await waitFor(() => expect(turnPost(calls)).toBeDefined());
    // Absent, not empty: the header names a Stack or it says nothing.
    expect(turnPost(calls)?.headers["x-stack-id"]).toBeUndefined();
    expect("x-stack-id" in (turnPost(calls)?.headers ?? {})).toBe(false);
  });
});
