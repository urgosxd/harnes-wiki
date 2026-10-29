import { describe, it, expect } from "vitest";
import { authHeaders, credentialsUrl, parseCredentials } from "./credentials.ts";

/**
 * Identity is the `user` in the link. There is no secret.
 *
 * That is a deliberate decision, not an oversight, and these tests pin both halves
 * of it: the name alone opens the product, and nothing here pretends to verify it.
 * A `token` is still forwarded when one is present, so an old link keeps working and
 * a deployment in roster mode can still be driven from the interface.
 */
describe("parseCredentials", () => {
  it("takes the user from the link, with no token anywhere", () => {
    expect(parseCredentials("?user=alice")).toEqual({ user: "alice" });
  });

  it("keeps a token when the link still carries one", () => {
    expect(parseCredentials("?user=alice&token=abc123")).toEqual({
      user: "alice",
      token: "abc123",
    });
  });

  it("refuses a link with no user, whatever else it carries", () => {
    // A token alone names nobody now: there is no roster to resolve it against, so
    // accepting it would mean guessing which account was meant.
    expect(parseCredentials("")).toBeNull();
    expect(parseCredentials("?token=abc123")).toBeNull();
    expect(parseCredentials("?user=")).toBeNull();
    expect(parseCredentials("?user=%20%20")).toBeNull();
  });

  it("ignores a blank token instead of forwarding an empty header", () => {
    expect(parseCredentials("?user=alice&token=")).toEqual({ user: "alice" });
    expect(parseCredentials("?user=alice&token=%20")).toEqual({ user: "alice" });
  });

  it("trims what a copy-paste adds, because a stray space is a different id", () => {
    expect(parseCredentials("?user=%20alice%0A&token=%20abc123%20")).toEqual({
      user: "alice",
      token: "abc123",
    });
  });
});

describe("authHeaders", () => {
  it("identifies the caller by name alone", () => {
    expect(authHeaders({ user: "alice" })).toEqual({ "x-user-id": "alice" });
  });

  it("forwards a token only when the link carried one", () => {
    expect(authHeaders({ user: "alice", token: "abc123" })).toEqual({
      "x-user-id": "alice",
      "x-dev-token": "abc123",
    });
  });
});

describe("credentialsUrl", () => {
  it("builds a link with the user, and the token only when present", () => {
    expect(credentialsUrl({ user: "alice" })).toBe("?user=alice");
    expect(credentialsUrl({ user: "alice", token: "abc123" })).toBe("?user=alice&token=abc123");
  });

  it("escapes a value that would otherwise break the query", () => {
    expect(credentialsUrl({ user: "a&b", token: "c=d e" })).toBe("?user=a%26b&token=c%3Dd+e");
  });
});
