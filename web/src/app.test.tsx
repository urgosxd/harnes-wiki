import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
