import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { fetchIdentity, signIn, signOut } from "./session.ts";

/**
 * The browser's side of the cookie session, through its three public functions.
 *
 * What this file pins is the MAPPING each call makes — a 401 from `/me` is "nobody is
 * signed in", a 401 from `/login` is a wrong user or password, a 429 is a lock, a 400 is
 * the server's own rule — and the three things this module must never do, whatever the
 * answer was: claim an identity in a header, replay the `sid` cookie itself, or keep a
 * copy of anything in a browser store. `fetch` is stubbed, so none of this needs a
 * server, and every request is recorded so the wire can be inspected after the fact.
 */

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

let calls: RecordedCall[] = [];

/**
 * Answer each request with the next queued response, recording what was sent.
 *
 * A request nobody queued throws: a case that sends MORE requests than expected has to
 * fail loudly, not be answered by a spare response.
 */
function stubFetch(handlers: Array<() => Response | Promise<Response>>): void {
  const queue = [...handlers];
  vi.stubGlobal("fetch", async (input: unknown, init: RequestInit = {}) => {
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      headers: { ...((init.headers ?? {}) as Record<string, string>) },
      body: init.body === undefined ? undefined : String(init.body),
    });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request to ${String(input)}`);
    return next();
  });
}

function jsonReply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The cross-cutting rules, checked in every case rather than in one test of their own.
 *
 * A module can break these on a failure path only — a 401 branch that "helpfully" retries
 * with an identity header, an error screen that stashes the account in `localStorage` —
 * which is exactly what a single happy-path test would never see.
 */
function expectNothingClaimedOrKept(): void {
  for (const call of calls) {
    const names = Object.keys(call.headers).map((name) => name.toLowerCase());
    for (const forbidden of ["x-user-id", "x-dev-token"]) {
      expect(names, `${call.method} ${call.url} must not carry ${forbidden}`).not.toContain(forbidden);
    }
    // The cookie is the browser's to send, and it is `HttpOnly`: this module cannot read it,
    // so any `sid=` in a header would mean a token came from somewhere it must not exist.
    const serializedHeaders = JSON.stringify(call.headers).toLowerCase();
    expect(serializedHeaders, `${call.method} ${call.url} must not carry a sid cookie`).not.toContain("sid=");
    expect(serializedHeaders, `${call.method} ${call.url} must send no cookie header`).not.toContain("cookie");
  }
  expect(localStorage.length, "nothing may be written to localStorage").toBe(0);
  expect(sessionStorage.length, "nothing may be written to sessionStorage").toBe(0);
}

beforeEach(() => {
  calls = [];
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchIdentity", () => {
  it("reads a 401 as nobody being signed in, not as a failure", async () => {
    stubFetch([() => jsonReply(401, { error: "unauthorized" })]);

    await expect(fetchIdentity()).resolves.toEqual({ kind: "signed-out" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/me");
    expect(calls[0]?.method).toBe("GET");
    expectNothingClaimedOrKept();
  });

  it("reports who the session belongs to", async () => {
    stubFetch([() => jsonReply(200, { id: "alice", displayName: "Alice" })]);

    await expect(fetchIdentity()).resolves.toEqual({
      kind: "authenticated",
      user: { id: "alice", displayName: "Alice" },
    });
    expectNothingClaimedOrKept();
  });

  it("throws on a 500 instead of telling a signed-in person they are signed out", async () => {
    stubFetch([() => jsonReply(500, { error: "internal", message: "database is down" })]);

    await expect(fetchIdentity()).rejects.toThrow("database is down");
    expectNothingClaimedOrKept();
  });
});

describe("signIn", () => {
  it("returns the account the server named", async () => {
    stubFetch([() => jsonReply(200, { user: { id: "alice", displayName: "Alice" } })]);

    await expect(signIn("alice", "correct horse battery")).resolves.toEqual({
      kind: "ok",
      user: { id: "alice", displayName: "Alice" },
    });

    expect(calls[0]?.url).toBe("/api/login");
    expect(calls[0]?.method).toBe("POST");
    // The form's decision, not this module's: it sends exactly what it was given, so the
    // wire shows what the screen chose.
    expect(JSON.parse(calls[0]!.body ?? "null")).toEqual({
      user: "alice",
      password: "correct horse battery",
    });
    expectNothingClaimedOrKept();
  });

  it("maps 401 to a wrong user or password", async () => {
    stubFetch([() => jsonReply(401, { error: "invalid_credentials", message: "User or password is incorrect" })]);

    await expect(signIn("alice", "wrong")).resolves.toEqual({ kind: "invalid_credentials" });
    expectNothingClaimedOrKept();
  });

  it("maps 429 to a locked account", async () => {
    stubFetch([() => jsonReply(429, { error: "too_many_attempts", message: "Too many failed attempts; try again later" })]);

    await expect(signIn("alice", "wrong")).resolves.toEqual({ kind: "too_many_attempts" });
    expectNothingClaimedOrKept();
  });

  it("carries the server's own message for a 400", async () => {
    stubFetch([
      () => jsonReply(400, { error: "invalid_request", message: "user and password are required" }),
    ]);

    // The server wrote the sentence the person has to act on; a client that replaced it
    // with "something went wrong" would be throwing away the only useful part.
    await expect(signIn("", "")).resolves.toEqual({
      kind: "invalid_request",
      message: "user and password are required",
    });
    expectNothingClaimedOrKept();
  });

  it("throws on a 500 and on a network that never answered", async () => {
    stubFetch([() => jsonReply(500, { error: "internal", message: "database is down" })]);
    await expect(signIn("alice", "correct horse battery")).rejects.toThrow("database is down");
    expectNothingClaimedOrKept();

    // A transport failure proves nothing about the credentials, so it is an error and not
    // a "wrong password" the person would answer by typing a correct one again.
    calls = [];
    stubFetch([() => Promise.reject(new TypeError("fetch failed"))]);
    await expect(signIn("alice", "correct horse battery")).rejects.toThrow("fetch failed");
    expectNothingClaimedOrKept();
  });
});

describe("signOut", () => {
  it("resolves when the server cleared the cookie", async () => {
    stubFetch([() => new Response(null, { status: 204 })]);

    await expect(signOut()).resolves.toBeUndefined();

    expect(calls[0]?.url).toBe("/api/logout");
    expect(calls[0]?.method).toBe("POST");
    expectNothingClaimedOrKept();
  });

  it("throws when the sign-out did not happen", async () => {
    stubFetch([() => jsonReply(500, { error: "internal", message: "database is down" })]);

    // The cookie is still valid in that case, and a screen that claimed otherwise would be
    // walked straight back through by the next request.
    await expect(signOut()).rejects.toThrow("database is down");
    expectNothingClaimedOrKept();
  });
});
