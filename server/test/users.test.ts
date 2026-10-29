import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRoster, resolveRosterUser, tokenMatches } from "../src/http/users.ts";
import { createAuthenticator, resolveAuthMode } from "../src/http/auth.ts";
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

/**
 * Open mode: the name in the request IS the identity, with no secret behind it.
 *
 * These tests pin what the mode does AND what it refuses to pretend. The id is a
 * claim the server cannot check, so the only thing worth asserting beyond "it is
 * accepted" is that a malformed or missing id cannot reach the database as a row.
 */
test("open mode resolves a caller from the claimed id alone", async () => {
  const authenticate = createAuthenticator({ mode: "open" });
  assert.equal(await authenticate(request({ "x-user-id": "alice" })), "alice");
  // No token anywhere in the request, and none required.
  assert.equal(await authenticate(request({ "x-user-id": "someone-else" })), "someone-else");
});

test("open mode refuses a request with no id", async () => {
  const authenticate = createAuthenticator({ mode: "open" });
  assert.equal(await authenticate(request({})), undefined);
  assert.equal(await authenticate(request({ "x-user-id": "   " })), undefined);
});

test("open mode refuses an id that would corrupt a row or a log line", async () => {
  const authenticate = createAuthenticator({ mode: "open" });
  // Not security: a slash or a space makes an unusable user_id, and an empty one
  // silently shares one bucket between everybody.
  assert.equal(await authenticate(request({ "x-user-id": "bad id!" })), undefined);
  assert.equal(await authenticate(request({ "x-user-id": "a/b" })), undefined);
  assert.equal(await authenticate(request({ "x-user-id": "x".repeat(65) })), undefined);
});

test("open mode accepts an id made of the characters this product uses", async () => {
  const authenticate = createAuthenticator({ mode: "open" });
  for (const id of ["alice", "ana.lopez", "j_doe", "ops@example.com", "team-1"]) {
    assert.equal(await authenticate(request({ "x-user-id": id })), id);
  }
});

test("inference never falls forward into open mode", async () => {
  // A server started with no identity configuration must refuse everything. If the
  // weakest mode were the fallback, forgetting an env var would silently publish
  // every conversation to anyone who could reach the port.
  assert.equal(resolveAuthMode({}), undefined);
  assert.equal(await createAuthenticator({})(request({ "x-user-id": "alice" })), undefined);
});

test("an explicit open mode wins over a configured roster and a shared token", async () => {
  // The precedence has to be stated, not inferred: with a roster present, an
  // operator switching to AUTH_MODE=open must actually get open mode.
  const authenticate = createAuthenticator({ mode: "open", users: ROSTER, devToken: "dev" });
  assert.equal(await authenticate(request({ "x-user-id": "alice" })), "alice");
});

test("an explicit roster mode wins over a shared token", async () => {
  const authenticate = createAuthenticator({ mode: "roster", users: ROSTER, devToken: "dev" });
  // The roster still refuses a claimed id that disagrees with the token.
  assert.equal(
    await authenticate(request({ "x-dev-token": "bob-token-bbbbbbbbbb", "x-user-id": "alice" })),
    undefined,
  );
});
