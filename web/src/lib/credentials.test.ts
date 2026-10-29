import { describe, it, expect } from "vitest";
import { authHeaders, credentialsUrl, parseCredentials } from "./credentials.ts";

/**
 * These cases encode the contract measured against the server, not a preference.
 *
 *   curl -H "x-dev-token: $TOK"                 /api/me  -> 200 {"id":"bob"}
 *   curl -H "x-dev-token: $TOK" -H "x-user-id;" /api/me  -> 401
 *
 * So the token alone is a complete identity, and a header sent with an empty value
 * is worse than a header not sent at all. The link carries `user` only so the
 * interface can name the account before `/me` answers.
 */
describe("parseCredentials", () => {
  it("treats the token alone as a complete identity", () => {
    expect(parseCredentials("?token=abc123")).toEqual({ token: "abc123" });
  });

  it("keeps the user when the link carries both halves", () => {
    expect(parseCredentials("?user=alice&token=abc123")).toEqual({
      token: "abc123",
      user: "alice",
    });
  });

  it("refuses a link with no token, whatever else it carries", () => {
    expect(parseCredentials("")).toBeNull();
    expect(parseCredentials("?user=alice")).toBeNull();
    expect(parseCredentials("?token=")).toBeNull();
    expect(parseCredentials("?token=%20%20")).toBeNull();
  });

  it("ignores a blank user instead of inventing one", () => {
    // `?user=&token=x` must not produce `{ user: "" }`: an empty header is refused.
    expect(parseCredentials("?user=&token=abc123")).toEqual({ token: "abc123" });
    expect(parseCredentials("?user=%20&token=abc123")).toEqual({ token: "abc123" });
  });

  it("trims what a copy-paste adds, because a trailing newline is a 401", () => {
    expect(parseCredentials("?user=%20alice%20&token=%20abc123%0A")).toEqual({
      token: "abc123",
      user: "alice",
    });
  });
});

describe("authHeaders", () => {
  it("sends the token alone when the link named no user", () => {
    // The whole bug: sending x-user-id with an empty value answers 401, so the
    // header must be absent rather than blank.
    expect(authHeaders({ token: "abc123" })).toEqual({ "x-dev-token": "abc123" });
  });

  it("sends both halves when the link named a user", () => {
    expect(authHeaders({ token: "abc123", user: "alice" })).toEqual({
      "x-dev-token": "abc123",
      "x-user-id": "alice",
    });
  });
});

describe("credentialsUrl", () => {
  it("writes the token into the link, keeping the user when there is one", () => {
    expect(credentialsUrl({ token: "abc123" })).toBe("?token=abc123");
    expect(credentialsUrl({ token: "abc123", user: "alice" })).toBe("?user=alice&token=abc123");
  });

  it("escapes a token that would otherwise break the query", () => {
    expect(credentialsUrl({ token: "a&b=c d" })).toBe("?token=a%26b%3Dc+d");
  });
});
