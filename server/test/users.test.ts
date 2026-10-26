import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRoster, resolveRosterUser, tokenMatches } from "../src/http/users.ts";
import { createAuthenticator } from "../src/http/auth.ts";
import type { IncomingMessage } from "node:http";

const ROSTER = "alice:alice-token-aaaaaaaa,bob:bob-token-bbbbbbbbbb";

test("two users each get their own secret", () => {
  const users = parseRoster(ROSTER);
  assert.equal(users.length, 2);
  assert.deepEqual(users.map((u) => u.id), ["alice", "bob"]);
});

test("a token identifies its own user", () => {
  const users = parseRoster(ROSTER);
  assert.equal(resolveRosterUser({ users, token: "alice-token-aaaaaaaa", claimedUserId: "alice" })?.id, "alice");
  assert.equal(resolveRosterUser({ users, token: "bob-token-bbbbbbbbbb", claimedUserId: "bob" })?.id, "bob");
});

test("the token alone is enough; a wrong claim is refused", () => {
  const users = parseRoster(ROSTER);
  // The measured hole: bob's token claiming to be alice.
  assert.equal(resolveRosterUser({ users, token: "bob-token-bbbbbbbbbb", claimedUserId: "alice" }), undefined);
  // Omitting the claim is fine: the token decides.
  assert.equal(resolveRosterUser({ users, token: "bob-token-bbbbbbbbbb", claimedUserId: undefined })?.id, "bob");
});

test("an unknown token resolves to nobody", () => {
  const users = parseRoster(ROSTER);
  assert.equal(resolveRosterUser({ users, token: "nope-nope-nope-nope", claimedUserId: "alice" }), undefined);
  assert.equal(resolveRosterUser({ users, token: undefined, claimedUserId: "alice" }), undefined);
});

test("tokens are compared in constant time and length mismatch is not a throw", () => {
  assert.equal(tokenMatches("abc", "abc"), true);
  assert.equal(tokenMatches("abc", "abcd"), false);
  assert.equal(tokenMatches("", "abc"), false);
});

test("a short token is refused at startup, because guessing is the attack", () => {
  assert.throws(() => parseRoster("alice:short"), /too short/);
});

test("a malformed roster names what is wrong", () => {
  assert.throws(() => parseRoster("alice-no-colon"), /must be id:token/);
  assert.throws(() => parseRoster("alice:token-aaaaaaaaaaaa,alice:token-bbbbbbbbbbbb"), /twice/);
  assert.throws(() => parseRoster("bad id!:token-aaaaaaaaaaaa"), /must match/);
  // Whitespace is an empty roster, not an error: the caller decides what to do.
  assert.deepEqual(parseRoster("   "), []);
});

function request(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

test("the authenticator refuses a stolen name with the wrong token", async () => {
  const authenticate = createAuthenticator({ users: ROSTER });

  assert.equal(await authenticate(request({ "x-dev-token": "alice-token-aaaaaaaa", "x-user-id": "alice" })), "alice");
  assert.equal(await authenticate(request({ "x-dev-token": "bob-token-bbbbbbbbbb", "x-user-id": "bob" })), "bob");

  // The impersonation attempt that succeeded before this change.
  assert.equal(
    await authenticate(request({ "x-dev-token": "bob-token-bbbbbbbbbb", "x-user-id": "alice" })),
    undefined,
  );
});

test("with no roster and no shared token, everything is refused", async () => {
  const authenticate = createAuthenticator({});
  assert.equal(await authenticate(request({ "x-user-id": "alice" })), undefined);
});

test("the legacy shared token still works, and still trusts the claimed id", async () => {
  const authenticate = createAuthenticator({ devToken: "dev" });
  // Documented weakness of legacy mode, kept only for an existing setup.
  assert.equal(await authenticate(request({ "x-dev-token": "dev", "x-user-id": "anyone" })), "anyone");
});
