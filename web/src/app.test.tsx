import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { App } from "./App.tsx";

/**
 * The regression this file exists for.
 *
 * The link carries the token, and the server authenticates on the token alone, yet
 * the product used to answer a token-only link with a sign-in form — asking for the
 * very secret the link already held, with the field prefilled to the literal "dev"
 * from a scheme that no longer exists.
 *
 * So the assertion is not "the form looks right". It is that NO form exists on any
 * path: no input, no submit, nothing to type.
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
  expect(screen.queryAllByLabelText(/token/i)).toHaveLength(0);
  expect(screen.queryAllByLabelText(/your name/i)).toHaveLength(0);
  expect(screen.queryAllByLabelText(/password/i)).toHaveLength(0);
  expect(screen.queryAllByText(/sign in/i)).toHaveLength(0);
  expect(screen.queryAllByText(/continue/i)).toHaveLength(0);
  expect(document.querySelectorAll("input")).toHaveLength(0);
}

describe("App identity from the link", () => {
  beforeEach(() => {
    useUrl("?token=abc123");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens the product from a token-only link, without asking for anything", async () => {
    // `/me` answers: this is what the server does for a valid roster token.
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "bob", displayName: "bob" })));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    // The identity is confirmed with the token alone, and `x-user-id` is absent
    // rather than blank — a blank value is a 401.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toEqual({ "x-dev-token": "abc123" });
    expectNoSignInForm();
  });

  it("keeps a `user` from the link as a display hint only", async () => {
    useUrl("?user=alice&token=abc123");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "alice", displayName: "alice" })));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toEqual({ "x-dev-token": "abc123", "x-user-id": "alice" });
    expectNoSignInForm();
  });

  it("explains a missing link instead of offering a form", () => {
    useUrl("");
    const fetchMock = noFetch();

    render(<App />);

    expect(screen.getByText(/needs your link/i)).toBeDefined();
    expectNoSignInForm();
    // Nothing was asked of the server: there is no credential to check.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains a rejected token instead of offering a form that cannot work", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByText(/no longer valid/i)).toBeDefined());
    expectNoSignInForm();
  });

  it("does not turn a server that is down into a credential problem", async () => {
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
