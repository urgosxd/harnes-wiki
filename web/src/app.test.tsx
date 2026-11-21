import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App.tsx";

/**
 * WHAT THIS FILE PINS
 *
 * Identity comes from the session cookie and from nothing else (S1, S3): the app asks
 * `GET /api/me`, shows the account it is given, and never sends `x-user-id` or
 * `x-dev-token` again. A URL that still carries `user` and `token` authenticates nobody
 * and is not an error either. `?stackId=<id>` keeps working exactly as it did (S2) and
 * still travels as `x-stack-id`.
 */

function useUrl(search: string) {
  window.history.replaceState(null, "", `/${search}`);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const ALICE = { id: "alice", displayName: "Alice" };

interface RecordedCall {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
  /** Every header the client sent, so a transport rule can be asserted rather than
   *  inferred from the URL. */
  headers: Record<string, string>;
}

type Route = [needle: string, handler: (call: RecordedCall) => Response | Promise<Response>];

/**
 * A stubbed server that records every call.
 *
 * `/api/me` answers the session — the account when `signedIn`, a 401 when not — and the
 * product's own reads answer empty, so only the traffic under test has to be described.
 * An unexpected request throws, which is how a stray call becomes a failure instead of
 * a silently plausible empty screen.
 */
function stubApi(routes: Route[] = [], options: { signedIn?: boolean } = {}) {
  const signedIn = options.signedIn ?? true;
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
    if (call.url.endsWith("/api/me")) {
      return signedIn ? json(ALICE) : json({ error: "unauthorized", message: "no session" }, 401);
    }
    if (call.url.includes("/conversations")) return json({ conversations: [] });
    if (call.url.includes("/documents")) return json({ documents: [] });
    if (call.url.includes("/stacks")) return json({ stackIds: [] });
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("App identity comes from the session", () => {
  it("renders the app for the account the session names", async () => {
    useUrl("?stackId=stack-a");
    const calls = stubApi();

    render(<App />);

    // The account the session answered with is the account on screen.
    await waitFor(() => expect(screen.getByTitle("Signed in as Alice")).toBeDefined());
    expect(screen.getByText("New chat")).toBeDefined();
    // It asked the session who it is, through the shared client and nothing else.
    expect(calls[0]?.url).toBe("/api/me");
    expect(calls[0]?.method).toBe("GET");
  });

  it("shows neither the app nor the login form while the session is unresolved", async () => {
    useUrl("?stackId=stack-a");
    let release!: (response: Response) => void;
    stubApi([
      [
        "/api/me",
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ],
    ]);

    render(<App />);

    // The neutral state: not a flash of the login form, not a flash of somebody's
    // conversations.
    expect(screen.getByText("Connecting…")).toBeDefined();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.queryByLabelText("User")).toBeNull();
    expect(screen.queryByText("New chat")).toBeNull();

    release(json(ALICE));
    await waitFor(() => expect(screen.getByText("New chat")).toBeDefined());
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.queryByText("Connecting…")).toBeNull();
  });

  it("asks for a user and a password when the session names nobody", async () => {
    useUrl("?stackId=stack-a");
    const calls = stubApi([], { signedIn: false });

    render(<App />);

    await waitFor(() => expect(screen.getByLabelText("Password")).toBeDefined());
    expect(screen.getByLabelText("User")).toBeDefined();
    expect(screen.queryByText("New chat")).toBeNull();
    // Nobody's data was asked for before someone signed in: the session question is
    // the only request, so not even the (unscoped) chat list was read.
    expect(calls.map((call) => call.url)).toEqual(["/api/me"]);
  });

  it("treats a link that still carries user and token as dead, not as dangerous", async () => {
    // S3: `user` and `token` leave the URL. The old link authenticates nobody, and the
    // honest answer for it is the login form — not a link error, and certainly not an
    // identity taken from the query string.
    useUrl("?user=alice&token=abc123&stackId=stack-a");
    const calls = stubApi([], { signedIn: false });

    render(<App />);

    await waitFor(() => expect(screen.getByLabelText("Password")).toBeDefined());
    expect(screen.queryByText(/not accepted/i)).toBeNull();
    expect(screen.queryByText(/needs a user in the link/i)).toBeNull();
    // It did not authenticate either: the only thing that left the browser was the
    // session question.
    expect(calls.map((call) => call.url)).toEqual(["/api/me"]);
    expect(
      calls.every(
        (call) => call.headers["x-user-id"] === undefined && call.headers["x-dev-token"] === undefined,
      ),
    ).toBe(true);
  });

  it("never sends x-user-id or x-dev-token, on any request, at any point", async () => {
    // The rule is about the whole session, so it is asserted over every request the
    // product made: the session question, the login, and everything after it.
    useUrl("?user=alice&token=abc123&stackId=stack-a");
    const calls = stubApi([["/api/login", () => json({ user: ALICE })]], { signedIn: false });

    render(<App />);
    await waitFor(() => expect(screen.getByLabelText("Password")).toBeDefined());
    fireEvent.change(screen.getByLabelText("User"), { target: { value: "alice" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByText("New chat")).toBeDefined());

    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      expect(call.headers["x-user-id"]).toBeUndefined();
      expect(call.headers["x-dev-token"]).toBeUndefined();
    }
  });

  it("renders the app with the session's identity after signing in, and leaves the URL alone", async () => {
    useUrl("?stackId=stack-a");
    const calls = stubApi([["/api/login", () => json({ user: ALICE })]], { signedIn: false });

    render(<App />);
    await waitFor(() => expect(screen.getByLabelText("Password")).toBeDefined());
    fireEvent.change(screen.getByLabelText("User"), { target: { value: "alice" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(screen.getByTitle("Signed in as Alice")).toBeDefined());
    // The identity on screen is the one the SERVER named, not the one that was typed.
    expect(screen.getByText("New chat")).toBeDefined();
    const login = calls.find((call) => call.url.endsWith("/api/login"));
    expect(login?.body).toEqual({ user: "alice", password: "s3cret" });
    // The pre-login URL is untouched: no `?user=`, no `?token=`, ever added to it.
    expect(window.location.search).toBe("?stackId=stack-a");
  });

  it("signs out and lands back on the login form", async () => {
    useUrl("?stackId=stack-a");
    const calls = stubApi([["/api/logout", () => new Response(null, { status: 204 })]]);

    render(<App />);
    await waitFor(() => expect(screen.getByText("New chat")).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(screen.getByLabelText("Password")).toBeDefined());
    const logout = calls.find((call) => call.url.endsWith("/api/logout"));
    expect(logout?.method).toBe("POST");
    // The app is gone: nothing of the previous session stays on screen.
    expect(screen.queryByText("New chat")).toBeNull();
  });

  it("says the server could not be reached, and retries instead of showing a form that cannot work", async () => {
    useUrl("?stackId=stack-a");
    let attempt = 0;
    stubApi([
      [
        "/api/me",
        () => {
          attempt += 1;
          if (attempt === 1) throw new Error("ECONNREFUSED");
          return json(ALICE);
        },
      ],
    ]);

    render(<App />);

    await waitFor(() => expect(screen.getByText(/Cannot reach the server/i)).toBeDefined());
    // Neither the login form (which would blame the person) nor a blank page.
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.queryByText("New chat")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("New chat")).toBeDefined());
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

describe("App ingest scoping from the link", () => {
  it("blocks the ingest surface and reads nothing when the link has no stackId", async () => {
    useUrl("?stackId=");
    const calls = stubApi();

    render(<App />);
    await screen.findByText("New chat");
    fireEvent.click(screen.getByText("Ingest jobs"));

    // The failure is visible and names what is missing and how the link must look.
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("stackId");
    // S3: the link it tells people to open no longer carries a user.
    expect(alert.textContent).toContain("?stackId=<stack-id>");
    expect(alert.textContent).not.toContain("?user=");
    // And there is no ingest surface behind it to read from.
    expect(screen.queryByLabelText("Source")).toBeNull();

    // The rule this exists for: no job list, no document list, no poll, no create.
    await waitFor(() => expect(screen.getByText("Back to chat")).toBeDefined());
    expect(dataReads(calls)).toEqual([]);
  });

  it("treats whitespace as no stackId, before any request", async () => {
    useUrl("?stackId=%20%20");
    const calls = stubApi();

    render(<App />);
    await screen.findByText("New chat");
    fireEvent.click(screen.getByText("Ingest jobs"));

    expect(screen.getByRole("alert").textContent).toContain("stackId");
    expect(dataReads(calls)).toEqual([]);
  });

  it("carries the link's stackId on the list, the poll and the create", async () => {
    useUrl("?stackId=0f8b1e42-1111-2222-3333-444455556666");
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
    useUrl("?stackId=not-a-stack");
    const calls = stubApi([
      [
        "/ingest/jobs",
        (call) => {
          if (call.method === "POST") {
            return json(
              { error: { code: "invalid_stack_id", message: "'not-a-stack' is not a Stack id." } },
              400,
            );
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
    const creates = calls.filter(
      (call) => call.method === "POST" && call.url.includes("/ingest/jobs"),
    );
    expect(creates).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      calls.filter((call) => call.method === "POST" && call.url.includes("/ingest/jobs")),
    ).toHaveLength(1);
  });
});

/**
 * The turn transport carries the Stack too.
 *
 * The ingest surface already names its Stack in the URL and the body; the chat's own
 * turn POST has no such place, so the link's Stack travels as `x-stack-id`. It is a
 * SELECTION, never an authorisation: the server derives no entitlement from it, and it
 * is the only way the agent's Stack-scoped tools learn which Stack to read.
 *
 * With no Stack in the link there is nothing to send, and the header must be absent
 * rather than empty — an empty value would name a Stack called "".
 */
function chatRoutes(): Route[] {
  return [
    [
      "/conversations",
      (call) => {
        if (call.method === "POST" && call.url.endsWith("/conversations")) {
          return json({ id: "c1", title: "hola", createdAt: "", updatedAt: "" }, 201);
        }
        if (call.url.endsWith("/conversations/c1/turns")) {
          // A turn stream that closes immediately: the test reads the request, not the
          // answer.
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
  it("sends x-stack-id equal to the link's stackId on the turn", async () => {
    const stack = "0f8b1e42-1111-2222-3333-444455556666";
    useUrl(`?stackId=${stack}`);
    const calls = stubApi(chatRoutes());

    await sendOneMessage();

    await waitFor(() => expect(turnPost(calls)).toBeDefined());
    expect(turnPost(calls)?.headers["x-stack-id"]).toBe(stack);
  });

  it("sends no x-stack-id at all when the link names no stackId", async () => {
    useUrl("");
    const calls = stubApi(chatRoutes());

    await sendOneMessage();

    await waitFor(() => expect(turnPost(calls)).toBeDefined());
    // Absent, not empty: the header names a Stack or it says nothing.
    expect(turnPost(calls)?.headers["x-stack-id"]).toBeUndefined();
    expect("x-stack-id" in (turnPost(calls)?.headers ?? {})).toBe(false);
  });

  it("still reads the Stack out of the URL, on every mount", async () => {
    useUrl("?stackId=stack-a");
    const calls = stubApi();
    const first = render(<App />);
    await waitFor(() =>
      expect(calls.some((call) => call.url === "/api/ingest/jobs?stackId=stack-a")).toBe(true),
    );
    first.unmount();

    useUrl("?stackId=stack-b");
    const mark = calls.length;
    render(<App />);

    await waitFor(() =>
      expect(calls.some((call) => call.url === "/api/ingest/jobs?stackId=stack-b")).toBe(true),
    );
    // The second mount's traffic belongs to the second Stack and to no other: the id is
    // read from the URL at mount, not remembered from the previous one.
    const afterRemount = calls.slice(mark);
    expect(afterRemount.length).toBeGreaterThan(0);
    expect(afterRemount.every((call) => (call.headers["x-stack-id"] ?? "stack-b") === "stack-b")).toBe(
      true,
    );
  });
});
