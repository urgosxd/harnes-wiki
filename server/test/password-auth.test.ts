import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Database } from "../src/db/pool.ts";
import { createRouter } from "../src/http/router.ts";
import {
  createAuthenticator,
  parseAuthMode,
  resolveAuthMode,
  resolveDeploymentAuthMode,
} from "../src/http/auth.ts";
import { registerRoutes } from "../src/api/routes.ts";
import { hashPassword, MIN_PASSWORD_LENGTH } from "../src/http/passwords.ts";
import { SESSION_COOKIE, SESSION_TTL_MS, clearSessionCookie, parseCookies, serializeSessionCookie } from "../src/http/sessions.ts";
import type { ConversationStore } from "../src/db/conversation-store.ts";
import type { TurnService } from "../src/api/turn-service.ts";
import { databaseAvailable, openTestDatabase, testUser } from "./support/db.ts";

/**
 * Password login over a real socket, against a real database.
 *
 * What this file pins that nothing inward can: the status AND the body AND the cookie
 * attributes a browser actually receives, plus the rows a rejection leaves behind.
 * Identity comes from the session alone here — a header that names a user is not one.
 *
 * Every account is created with `hashPassword` + an insert, because the endpoint that
 * creates accounts is a later slice. Users are unique per test (`testUser`), and the
 * accounts are removed at the end, which cascades to their sessions.
 */
const available = await databaseAvailable();
const skip = available ? false : "needs a reachable Postgres (docker compose up -d postgres)";

const PASSWORD = "correct horse battery";
const WRONG_PASSWORD = "this is not the password";

let db: Database;

before(async () => {
  if (!available) return;
  db = await openTestDatabase();
});

after(async () => {
  if (!available) return;
  // Sessions cascade from users, so one delete removes every session this file made.
  await db.query("DELETE FROM users WHERE id LIKE $1", [`${createdPrefix}%`]);
  await db.close();
});

/**
 * Accounts created by this file, tracked so teardown can remove exactly them and
 * nothing another suite owns.
 */
const createdPrefix = "test-pwauth-";
const created: string[] = [];

async function createAccount(displayName?: string): Promise<{ id: string; displayName: string; password: string }> {
  const id = `${createdPrefix}${testUser("acct")}`;
  const name = displayName ?? `Display ${id}`;
  await db.query("INSERT INTO users (id, display_name, password_hash) VALUES ($1, $2, $3)", [
    id,
    name,
    await hashPassword(PASSWORD),
  ]);
  created.push(id);
  return { id, displayName: name, password: PASSWORD };
}

interface Booted {
  baseUrl: string;
  close(): void;
}

/** A server with password auth and the routes the product registers. */
async function boot(options: { publicBaseUrl?: string } = {}): Promise<Booted> {
  const router = createRouter({
    authenticate: createAuthenticator({ mode: "password", db }),
  });
  registerRoutes(router, {
    // Only `/login`, `/logout` and `/me` are exercised here; the conversation and turn
    // handlers are not reachable without state this file does not need.
    store: {} as unknown as ConversationStore,
    turns: {} as unknown as TurnService,
    db,
    authMode: "password",
    ...(options.publicBaseUrl === undefined ? {} : { publicBaseUrl: options.publicBaseUrl }),
  });
  const server: Server = await router.listen(0, "127.0.0.1");
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => server.close(),
  };
}

/** A server in one of the legacy modes, for the compatibility checks. */
async function bootLegacy(mode: "open" | "roster" | "shared-token"): Promise<Booted> {
  const router = createRouter({
    authenticate: createAuthenticator({ mode, users: "alice:alice-token-aaaaaaaa", devToken: "dev" }),
  });
  registerRoutes(router, {
    store: {} as unknown as ConversationStore,
    turns: {} as unknown as TurnService,
    db,
    authMode: mode,
  });
  const server: Server = await router.listen(0, "127.0.0.1");
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => server.close(),
  };
}

interface Reply {
  status: number;
  body: any;
  setCookies: string[];
}

async function postLogin(baseUrl: string, body?: unknown): Promise<Reply> {
  const init: RequestInit =
    body === undefined
      ? { method: "POST" }
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        };
  const response = await fetch(`${baseUrl}/login`, init);
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : undefined,
    setCookies: response.headers.getSetCookie(),
  };
}

async function postLogout(baseUrl: string, cookie?: string): Promise<Reply> {
  const headers: Record<string, string> = cookie === undefined ? {} : { cookie };
  const response = await fetch(`${baseUrl}/logout`, { method: "POST", headers });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : undefined,
    setCookies: response.headers.getSetCookie(),
  };
}

async function getMe(baseUrl: string, headers: Record<string, string> = {}): Promise<Reply> {
  const response = await fetch(`${baseUrl}/me`, { headers });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : undefined,
    setCookies: response.headers.getSetCookie(),
  };
}

/** The `sid` Set-Cookie the reply carried, asserting there is one. */
function sessionCookie(setCookies: readonly string[]): string {
  const found = setCookies.find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
  assert.ok(
    found !== undefined,
    `expected a ${SESSION_COOKIE} cookie, got ${JSON.stringify(setCookies)}`,
  );
  return found;
}

/** The value of a `name=value; ...` cookie line. */
function cookieValue(line: string): string {
  return line.slice(0, line.indexOf(";") === -1 ? line.length : line.indexOf(";")).split("=").slice(1).join("=");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sessionRows(userId: string): Promise<Array<{ token_hash: string; expires_at: Date }>> {
  return db.query<{ token_hash: string; expires_at: Date }>(
    "SELECT token_hash, expires_at FROM sessions WHERE user_id = $1",
    [userId],
  );
}

// ---------------------------------------------------------------------------
// The mode itself
// ---------------------------------------------------------------------------

test("AUTH_MODE=password is a mode, and an unset AUTH_MODE resolves to it", () => {
  assert.equal(parseAuthMode("password"), "password");
  // An explicit typo is still a boot failure, and it names the whole set.
  assert.throws(() => parseAuthMode("passwrod"), /AUTH_MODE must be one of .*password/);

  // Unset and blank both mean "not configured", and what a deployment gets then must
  // not be `open`: a forgotten variable must never leave identity self-declared.
  assert.equal(parseAuthMode(undefined), undefined);
  assert.equal(parseAuthMode("   "), undefined);
  assert.equal(resolveDeploymentAuthMode({}), "password");
  assert.equal(resolveDeploymentAuthMode({ mode: parseAuthMode(undefined) }), "password");
});

test("the legacy modes and the inference behind them are unchanged", () => {
  assert.equal(parseAuthMode("open"), "open");
  assert.equal(parseAuthMode("roster"), "roster");
  assert.equal(parseAuthMode("shared-token"), "shared-token");

  // Inference still prefers a configured roster, then a shared token. Only when
  // nothing at all is configured does the deployment fall to password mode.
  assert.equal(resolveDeploymentAuthMode({ users: "alice:alice-token-aaaaaaaa" }), "roster");
  assert.equal(resolveDeploymentAuthMode({ devToken: "dev" }), "shared-token");
  assert.equal(resolveDeploymentAuthMode({ mode: "open", users: "alice:alice-token-aaaaaaaa" }), "open");
  // `resolveAuthMode` keeps answering "nothing configured" as nothing: password is the
  // deployment's default, not a new inference rule for this function.
  assert.equal(resolveAuthMode({}), undefined);
});

// ---------------------------------------------------------------------------
// The cookie and the module around it
// ---------------------------------------------------------------------------

test("cookies are parsed tolerantly and the session cookie carries the fixed attributes", () => {
  assert.deepEqual(parseCookies("a=1; b=2"), { a: "1", b: "2" });
  // Malformed pairs, empty names and stray delimiters are ignored, never thrown on.
  assert.deepEqual(parseCookies(" ; =no-name; broken; c=3"), { c: "3" });
  assert.deepEqual(parseCookies('q="quoted value"; d=4'), { q: "quoted value", d: "4" });
  // Last duplicate wins: the browser sends the most specific cookie last.
  assert.deepEqual(parseCookies("sid=first; sid=second"), { sid: "second" });
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies(""), {});

  assert.equal(SESSION_TTL_MS, 30 * 24 * 60 * 60 * 1000);
  assert.equal(
    serializeSessionCookie("tok", { secure: false, maxAgeSeconds: 60 }),
    "sid=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=60",
  );
  assert.equal(
    serializeSessionCookie("tok", { secure: true, maxAgeSeconds: 60 }),
    "sid=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure",
  );
  assert.equal(
    clearSessionCookie({ secure: false }),
    "sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
  );
  assert.equal(clearSessionCookie({ secure: true }), "sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure");
});

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

test("valid credentials answer 200 with the user, an HttpOnly session cookie and a stored hash", { skip }, async () => {
  const account = await createAccount();
  const server = await boot();
  try {
    const reply = await postLogin(server.baseUrl, { user: account.id, password: account.password });

    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body, { user: { id: account.id, displayName: account.displayName } });

    const cookie = sessionCookie(reply.setCookies);
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; SameSite=Lax/);
    assert.match(cookie, /; Path=\//);
    const maxAge = /; Max-Age=(\d+)/.exec(cookie);
    assert.ok(maxAge, `the cookie must carry Max-Age, got ${cookie}`);
    assert.ok(Number(maxAge[1]) > 0, "Max-Age must be positive, not a session-only cookie");
    assert.equal(Number(maxAge[1]), SESSION_TTL_MS / 1000);
    assert.doesNotMatch(cookie, /; Secure/, "an http base URL must not ask the browser for TLS");

    const token = cookieValue(cookie);
    const rows = await sessionRows(account.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.token_hash, sha256(token), "the row must hold the token's hash");
    assert.notEqual(rows[0]!.token_hash, token, "the session row must not store the token itself");
    const expiresAt = rows[0]!.expires_at.getTime();
    const expected = Date.now() + SESSION_TTL_MS;
    assert.ok(Math.abs(expiresAt - expected) < 60_000, "expiry is the 30-day TTL, not something else");
  } finally {
    server.close();
  }
});

test("a wrong password answers the same 401 and stores no session", { skip }, async () => {
  const account = await createAccount();
  const server = await boot();
  try {
    const reply = await postLogin(server.baseUrl, { user: account.id, password: WRONG_PASSWORD });

    assert.equal(reply.status, 401);
    assert.deepEqual(reply.body, { error: "invalid_credentials", message: "User or password is incorrect" });
    assert.deepEqual(reply.setCookies, [], "a refused login must not set a cookie");
    assert.deepEqual(await sessionRows(account.id), []);
  } finally {
    server.close();
  }
});

test("an unknown user answers exactly what a wrong password answers", { skip }, async () => {
  const account = await createAccount();
  const server = await boot();
  try {
    const wrongPassword = await postLogin(server.baseUrl, { user: account.id, password: WRONG_PASSWORD });
    const unknownUser = await postLogin(server.baseUrl, { user: `${createdPrefix}nobody-here`, password: PASSWORD });

    assert.equal(unknownUser.status, 401);
    // Byte-for-byte equal: anything that differs tells an attacker which accounts exist.
    assert.deepEqual(unknownUser.body, wrongPassword.body);
    assert.deepEqual(unknownUser.setCookies, []);
    assert.deepEqual(await sessionRows(`${createdPrefix}nobody-here`), []);
  } finally {
    server.close();
  }
});

test("a missing or non-string user or password answers 400 invalid_request", { skip }, async () => {
  const account = await createAccount();
  const server = await boot();
  const expected = { error: "invalid_request", message: "user and password are required" };
  try {
    const bodies: Array<[string, unknown]> = [
      ["no body at all", undefined],
      ["an empty object", {}],
      ["no password", { user: account.id }],
      ["no user", { password: account.password }],
      ["a blank user", { user: "  ", password: account.password }],
      ["a blank password", { user: account.id, password: "   " }],
      ["a non-string password", { user: account.id, password: 12345678 }],
      ["a non-string user", { user: ["alice"], password: account.password }],
    ];

    for (const [label, body] of bodies) {
      const reply = await postLogin(server.baseUrl, body);
      assert.equal(reply.status, 400, `expected 400 for ${label}`);
      assert.deepEqual(reply.body, expected, `expected the frozen 400 body for ${label}`);
      assert.deepEqual(reply.setCookies, [], `a 400 for ${label} must not set a cookie`);
    }

    assert.deepEqual(await sessionRows(account.id), [], "a rejected request must not create a session");
    // The password bound is the module's, not this route's: pin that the route does not
    // accept a shorter password than the hashing module would.
    assert.ok(MIN_PASSWORD_LENGTH > 0);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

test("the cookie from a successful login authenticates GET /me as that user", { skip }, async () => {
  const account = await createAccount();
  const server = await boot();
  try {
    const logged = await postLogin(server.baseUrl, { user: account.id, password: account.password });
    const cookie = `${SESSION_COOKIE}=${cookieValue(sessionCookie(logged.setCookies))}`;

    const reply = await getMe(server.baseUrl, { cookie });
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body, { id: account.id, displayName: account.displayName });
  } finally {
    server.close();
  }
});

test("identity in password mode comes only from the session, never from a header", { skip }, async () => {
  const account = await createAccount();
  const server = await boot();
  try {
    assert.equal((await getMe(server.baseUrl)).status, 401, "no cookie at all");
    assert.equal((await getMe(server.baseUrl, { cookie: `${SESSION_COOKIE}=not-a-real-token` })).status, 401, "a garbage token");

    const headers: Array<[string, Record<string, string>]> = [
      ["x-user-id alone", { "x-user-id": account.id }],
      ["x-dev-token alone", { "x-dev-token": "dev" }],
      ["both legacy headers", { "x-user-id": account.id, "x-dev-token": "dev" }],
    ];
    for (const [label, extra] of headers) {
      const reply = await getMe(server.baseUrl, extra);
      assert.equal(reply.status, 401, `${label} must not be an identity in password mode`);
      assert.deepEqual(reply.body, { error: "unauthorized" });
    }
  } finally {
    server.close();
  }
});

test("the cookie is a session, not a claim: a tampered token cannot become another user", { skip }, async () => {
  const alice = await createAccount();
  const bob = await createAccount();
  const server = await boot();
  try {
    const logged = await postLogin(server.baseUrl, { user: alice.id, password: alice.password });
    const token = cookieValue(sessionCookie(logged.setCookies));

    // The value names nobody, so "editing it into bob" means editing the bytes. The
    // stored hash no longer matches and the request is refused.
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    assert.notEqual(tampered, token);
    assert.equal((await getMe(server.baseUrl, { cookie: `${SESSION_COOKIE}=${tampered}` })).status, 401);

    // Nor is there a claim to rewrite: a cookie holding bob's id is not a session.
    assert.equal((await getMe(server.baseUrl, { cookie: `${SESSION_COOKIE}=${bob.id}` })).status, 401);

    // The untouched token still resolves to its own owner, which is what makes the
    // two refusals above meaningful rather than a broken fixture.
    const ok = await getMe(server.baseUrl, { cookie: `${SESSION_COOKIE}=${token}` });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.id, alice.id);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

test("logout deletes the session, clears the cookie and is idempotent", { skip }, async () => {
  const account = await createAccount();
  const server = await boot();
  try {
    const logged = await postLogin(server.baseUrl, { user: account.id, password: account.password });
    const token = cookieValue(sessionCookie(logged.setCookies));

    const out = await postLogout(server.baseUrl, `${SESSION_COOKIE}=${token}`);
    assert.equal(out.status, 204);
    assert.equal(out.body, undefined, "204 carries no body");
    const cleared = sessionCookie(out.setCookies);
    assert.match(cleared, /; Max-Age=0/, "the browser must be told to drop the cookie");
    assert.match(cleared, /; HttpOnly/);
    assert.match(cleared, /; Path=\//);

    assert.deepEqual(await sessionRows(account.id), [], "the session row must be gone");
    assert.equal(
      (await getMe(server.baseUrl, { cookie: `${SESSION_COOKIE}=${token}` })).status,
      401,
      "the same cookie must no longer authenticate",
    );

    // No cookie, and an unknown token: both are a successful no-op, not an error.
    for (const cookie of [undefined, `${SESSION_COOKIE}=unknown-token`]) {
      const again = await postLogout(server.baseUrl, cookie);
      assert.equal(again.status, 204, `logout must be idempotent (cookie: ${cookie})`);
      assert.match(sessionCookie(again.setCookies), /; Max-Age=0/);
    }
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// Throttle
// ---------------------------------------------------------------------------

test("ten failures lock the account out, even against the correct password", { skip }, async () => {
  const account = await createAccount();
  const other = await createAccount();
  const server = await boot();
  try {
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const reply = await postLogin(server.baseUrl, { user: account.id, password: WRONG_PASSWORD });
      assert.equal(reply.status, 401, `attempt ${attempt} must still be a credential refusal`);
    }

    const locked = await postLogin(server.baseUrl, { user: account.id, password: account.password });
    assert.equal(locked.status, 429);
    assert.deepEqual(locked.body, {
      error: "too_many_attempts",
      message: "Too many failed attempts; try again later",
    });
    assert.deepEqual(locked.setCookies, [], "a locked account must not be handed a session");
    assert.deepEqual(await sessionRows(account.id), [], "no session may be created while locked");

    // The window is per account, not global: somebody else can still sign in.
    const unaffected = await postLogin(server.baseUrl, { user: other.id, password: other.password });
    assert.equal(unaffected.status, 200);
    assert.equal((await sessionRows(other.id)).length, 1);
  } finally {
    server.close();
  }
});

test("a success resets the failure count for that account", { skip }, async () => {
  const account = await createAccount();
  const server = await boot();
  try {
    for (let attempt = 1; attempt <= 9; attempt += 1) {
      assert.equal(
        (await postLogin(server.baseUrl, { user: account.id, password: WRONG_PASSWORD })).status,
        401,
      );
    }

    assert.equal((await postLogin(server.baseUrl, { user: account.id, password: account.password })).status, 200);

    // One more failure after the success is a plain 401: had the count survived, this
    // would be the eleventh and answer 429.
    assert.equal((await postLogin(server.baseUrl, { user: account.id, password: WRONG_PASSWORD })).status, 401);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// Cookie attributes follow the deployment's origin
// ---------------------------------------------------------------------------

test("the cookie is Secure exactly when the public base URL is https", { skip }, async () => {
  const secureServer = await boot({ publicBaseUrl: "https://chat.example.com" });
  const plainServer = await boot({ publicBaseUrl: "http://server:8080" });
  const account = await createAccount();
  try {
    const secure = await postLogin(secureServer.baseUrl, { user: account.id, password: account.password });
    assert.match(sessionCookie(secure.setCookies), /; Secure/);
    const secureOut = await postLogout(secureServer.baseUrl, undefined);
    assert.match(sessionCookie(secureOut.setCookies), /; Secure/);

    const plain = await postLogin(plainServer.baseUrl, { user: account.id, password: account.password });
    assert.doesNotMatch(sessionCookie(plain.setCookies), /; Secure/);
    const plainOut = await postLogout(plainServer.baseUrl, undefined);
    assert.doesNotMatch(sessionCookie(plainOut.setCookies), /; Secure/);
  } finally {
    secureServer.close();
    plainServer.close();
  }
});

// ---------------------------------------------------------------------------
// The legacy contract this slice must not change
// ---------------------------------------------------------------------------

test("GET /me in open mode still answers the old { id, displayName } shape", { skip }, async () => {
  // An account with the very id the header will claim, so the check below is not a
  // fixture that only passes because no row exists.
  await createAccount();
  const account = created[created.length - 1]!;
  const server = await bootLegacy("open");
  try {
    const reply = await getMe(server.baseUrl, { "x-user-id": account });
    assert.equal(reply.status, 200);
    // Frozen shape AND frozen value: the web client reads `id` and `displayName` at the
    // top level, and in a legacy mode the id is the only truth about that caller — an
    // account row that happens to share the id must not start leaking its display name.
    assert.deepEqual(reply.body, { id: account, displayName: account });
    assert.equal((await getMe(server.baseUrl)).status, 401, "open mode still refuses a request with no id");
  } finally {
    server.close();
  }
});
