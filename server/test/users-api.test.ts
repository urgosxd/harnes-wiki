import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Database } from "../src/db/pool.ts";
import { ConversationStore } from "../src/db/conversation-store.ts";
import { createRouter } from "../src/http/router.ts";
import { createAuthenticator } from "../src/http/auth.ts";
import { registerRoutes } from "../src/api/routes.ts";
import { hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "../src/http/passwords.ts";
import { SESSION_COOKIE } from "../src/http/sessions.ts";
import type { TurnService } from "../src/api/turn-service.ts";
import { databaseAvailable, openTestDatabase, testUser } from "./support/db.ts";

/**
 * `POST /users` over a real socket, against a real database (S4, S6).
 *
 * What this file pins that nothing inward can: the status AND the body AND the rows a
 * request leaves behind — including that a rejection leaves the `users` table exactly as
 * it found it. The session on every request is a real one, obtained from `POST /login`
 * with a real password; a hand-built cookie would prove nothing about the endpoint being
 * reachable by an account that exists.
 *
 * The actor is a fixture row inserted with `hashPassword`, because the only way to reach
 * the endpoint is to be signed in already — the same bootstrap a fresh deployment gets
 * from the seeded accounts. Everything else goes through the endpoint under test.
 */
const available = await databaseAvailable();
const skip = available ? false : "needs a reachable Postgres (docker compose up -d postgres)";

const PASSWORD = "correct horse battery";
const createdPrefix = "test-usersapi-";

const ID_MESSAGE = "user must match [A-Za-z0-9._@-] and be at most 64 characters";
const PASSWORD_MESSAGE = `Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`;
const DISPLAY_NAME_MESSAGE = "displayName must be at most 120 characters";

let db: Database;
let store: ConversationStore;

before(async () => {
  if (!available) return;
  db = await openTestDatabase();
  store = new ConversationStore(db);
});

after(async () => {
  if (!available) return;
  // Transcripts first, then the accounts: `conversations.user_id` has no foreign key
  // (rows are keyed before an account exists), so the cascade does not clean this up.
  await db.query("DELETE FROM conversations WHERE user_id LIKE $1", [`${createdPrefix}%`]);
  await db.query("DELETE FROM users WHERE id LIKE $1", [`${createdPrefix}%`]);
  await db.close();
});

interface Booted {
  baseUrl: string;
  close(): void;
}

/** A server with password auth and the product's routes, over the test database. */
async function boot(): Promise<Booted> {
  const router = createRouter({
    authenticate: createAuthenticator({ mode: "password", db }),
  });
  registerRoutes(router, {
    store,
    // No turn is started here; the conversation handlers only need the store.
    turns: {} as unknown as TurnService,
    db,
    authMode: "password",
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

async function send(
  baseUrl: string,
  path: string,
  options: { method?: string; cookie?: string | undefined; body?: unknown } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  let payload: string | undefined;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(options.body);
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(payload === undefined ? {} : { body: payload }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : undefined,
    setCookies: response.headers.getSetCookie(),
  };
}

/** The `sid` value the reply set, asserting there was one. */
function sessionCookie(setCookies: readonly string[]): string {
  const line = setCookies.find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
  assert.ok(line !== undefined, `expected a ${SESSION_COOKIE} cookie, got ${JSON.stringify(setCookies)}`);
  return line;
}

/** Sign in and return the `Cookie` header for later requests. */
async function signIn(baseUrl: string, user: string, password: string): Promise<{ status: number; body: any; cookie: string }> {
  const reply = await send(baseUrl, "/login", { method: "POST", body: { user, password } });
  if (reply.status !== 200) return { status: reply.status, body: reply.body, cookie: "" };
  const line = sessionCookie(reply.setCookies);
  return {
    status: reply.status,
    body: reply.body,
    cookie: `${SESSION_COOKIE}=${line.slice(line.indexOf("=") + 1, line.indexOf(";") === -1 ? undefined : line.indexOf(";"))}`,
  };
}

function createUser(baseUrl: string, cookie: string | undefined, body: unknown): Promise<Reply> {
  return send(baseUrl, "/users", { method: "POST", cookie, body });
}

/** A fresh id that this file owns, so two runs never collide. */
function freshId(label = "new"): string {
  return `${createdPrefix}${testUser(label)}`;
}

/** An account that already exists, so there is somebody to sign in as. */
async function existingAccount(): Promise<{ id: string; password: string }> {
  const id = freshId("actor");
  await db.query("INSERT INTO users (id, display_name, password_hash) VALUES ($1, $2, $3)", [
    id,
    `Display ${id}`,
    await hashPassword(PASSWORD),
  ]);
  return { id, password: PASSWORD };
}

async function userRows(id: string): Promise<Array<{ id: string; display_name: string; password_hash: string }>> {
  return db.query<{ id: string; display_name: string; password_hash: string }>(
    "SELECT id, display_name, password_hash FROM users WHERE id = $1",
    [id],
  );
}

/** How many accounts this file owns, so "unchanged" is measured against its own rows. */
async function ownedRowCount(): Promise<number> {
  const rows = await db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM users WHERE id LIKE $1",
    [`${createdPrefix}%`],
  );
  return rows[0]?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

test("a signed-in caller creates an account, and that account can sign in", { skip }, async () => {
  const actor = await existingAccount();
  const server = await boot();
  try {
    const signedIn = await signIn(server.baseUrl, actor.id, actor.password);
    assert.equal(signedIn.status, 200, "the fixture actor must be able to sign in");

    const id = freshId("created");
    const created = await createUser(server.baseUrl, signedIn.cookie, {
      user: id,
      password: "a-fresh-password",
      displayName: "Fresh Account",
    });

    assert.equal(created.status, 201);
    assert.deepEqual(created.body, { user: { id, displayName: "Fresh Account" } });

    const rows = await userRows(id);
    assert.equal(rows.length, 1, "the account must exist");
    assert.equal(rows[0]!.display_name, "Fresh Account");
    assert.match(rows[0]!.password_hash, /^scrypt\$/, "the row must hold a hash, not the password");
    assert.notEqual(rows[0]!.password_hash, "a-fresh-password");

    // End to end, through the public interface: the stored hash has to VERIFY, not just
    // exist. Signing in with the password the endpoint was given proves that.
    const newAccount = await signIn(server.baseUrl, id, "a-fresh-password");
    assert.equal(newAccount.status, 200);
    assert.deepEqual(newAccount.body, { user: { id, displayName: "Fresh Account" } });

    const me = await send(server.baseUrl, "/me", { cookie: newAccount.cookie });
    assert.equal(me.status, 200);
    assert.deepEqual(me.body, { id, displayName: "Fresh Account" });
  } finally {
    server.close();
  }
});

test("a duplicate id answers 409 and leaves the existing row untouched", { skip }, async () => {
  const actor = await existingAccount();
  const server = await boot();
  try {
    const signedIn = await signIn(server.baseUrl, actor.id, actor.password);

    const id = freshId("taken");
    const first = await createUser(server.baseUrl, signedIn.cookie, { user: id, password: "the-first-password" });
    assert.equal(first.status, 201);
    const before = await userRows(id);
    assert.equal(before.length, 1);

    const second = await createUser(server.baseUrl, signedIn.cookie, {
      user: id,
      password: "a-different-password",
      displayName: "Somebody Else",
    });

    assert.equal(second.status, 409);
    assert.deepEqual(second.body, { error: "user_exists", message: `User "${id}" already exists` });

    // Byte-identical: a duplicate must never be an update. Resetting somebody's password
    // by "creating" their account again is the failure this pins.
    const after = await userRows(id);
    assert.deepEqual(after, before, "the existing account must be exactly as it was");
  } finally {
    server.close();
  }
});

test("an invalid id, password or display name answers 400 and stores nothing", { skip }, async () => {
  const actor = await existingAccount();
  const server = await boot();
  try {
    const signedIn = await signIn(server.baseUrl, actor.id, actor.password);
    const baseline = await ownedRowCount();

    const longId = "u".repeat(65);
    const cases: Array<[string, unknown, string, string | undefined]> = [
      ["an id with a space", { user: "bad id", password: PASSWORD }, ID_MESSAGE, undefined],
      ["an id of 65 characters", { user: longId, password: PASSWORD }, ID_MESSAGE, longId],
      ["an empty id", { user: "   ", password: PASSWORD }, ID_MESSAGE, undefined],
      [
        "a password one character too short",
        { user: freshId("shortpw"), password: "x".repeat(MIN_PASSWORD_LENGTH - 1) },
        PASSWORD_MESSAGE,
        undefined,
      ],
      [
        "a password one character too long",
        { user: freshId("longpw"), password: "x".repeat(MAX_PASSWORD_LENGTH + 1) },
        PASSWORD_MESSAGE,
        undefined,
      ],
      [
        "a display name of 121 characters",
        { user: freshId("longname"), password: PASSWORD, displayName: "n".repeat(121) },
        DISPLAY_NAME_MESSAGE,
        undefined,
      ],
    ];

    for (const [label, body, message, attemptedId] of cases) {
      const reply = await createUser(server.baseUrl, signedIn.cookie, body);
      assert.equal(reply.status, 400, `expected 400 for ${label}`);
      assert.deepEqual(reply.body, { error: "invalid_request", message }, `expected the frozen 400 body for ${label}`);
      // Nothing was stored: neither under the id in the body nor anywhere else this file
      // writes. Checked per id as well, because a rejected request must not create a row
      // under a trimmed or truncated version of what was sent.
      const sentId = typeof (body as { user?: unknown }).user === "string" ? (body as { user: string }).user.trim() : "";
      for (const candidate of [sentId, attemptedId]) {
        if (!candidate) continue;
        assert.deepEqual(await userRows(candidate), [], `${label} must not create an account`);
      }
    }

    assert.equal(await ownedRowCount(), baseline, "a rejected request must not change the row count");
  } finally {
    server.close();
  }
});

test("creating an account requires a session", { skip }, async () => {
  const server = await boot();
  try {
    const id = freshId("anonymous");
    const reply = await createUser(server.baseUrl, undefined, { user: id, password: PASSWORD });

    assert.equal(reply.status, 401);
    assert.deepEqual(reply.body, { error: "unauthorized" });
    assert.deepEqual(await userRows(id), [], "an anonymous request must not create an account");
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// S6: everybody has the same permissions
// ---------------------------------------------------------------------------

test("a user created through the endpoint gets the same permissions, and no less isolation", { skip }, async () => {
  const actor = await existingAccount();
  const server = await boot();
  try {
    const actorSession = await signIn(server.baseUrl, actor.id, actor.password);

    // The actor's own conversation, so "C cannot see it" has something to be wrong about.
    const conversation = await send(server.baseUrl, "/conversations", {
      method: "POST",
      cookie: actorSession.cookie,
      body: { title: "the actor's conversation" },
    });
    assert.equal(conversation.status, 201);
    const conversationId = conversation.body.id as string;
    assert.equal(typeof conversationId, "string");

    const id = freshId("created-by-actor");
    const created = await createUser(server.baseUrl, actorSession.cookie, {
      user: id,
      password: "created-by-another-user",
    });
    assert.equal(created.status, 201, "any signed-in user may create users; there is no owner of an account");

    const session = await signIn(server.baseUrl, id, "created-by-another-user");
    assert.equal(session.status, 200);

    const me = await send(server.baseUrl, "/me", { cookie: session.cookie });
    assert.equal(me.status, 200);
    assert.equal(me.body.id, id, "the new account signs in as itself");

    // Same permissions, and the same per-`user_id` scoping as everybody else: creating a
    // user grants nothing to the creator, and takes nothing from the created.
    const list = await send(server.baseUrl, "/conversations", { cookie: session.cookie });
    assert.equal(list.status, 200);
    assert.deepEqual(
      (list.body.conversations as Array<{ id: string }>).map((entry) => entry.id),
      [],
      "the new account must not see the creator's conversations",
    );
    const foreign = await send(server.baseUrl, `/conversations/${conversationId}`, { cookie: session.cookie });
    assert.equal(foreign.status, 404, "a conversation owned by somebody else answers like a missing one");
    assert.deepEqual(foreign.body, { error: "not_found" });

    // The creator still owns what it created, which is what makes the two checks above
    // about scoping rather than a broken fixture.
    const own = await send(server.baseUrl, `/conversations/${conversationId}`, { cookie: actorSession.cookie });
    assert.equal(own.status, 200);
    assert.equal(own.body.id, conversationId);

    // No hierarchy either: the account that was just created can create one too.
    const fourth = await createUser(server.baseUrl, session.cookie, {
      user: freshId("created-by-new"),
      password: "created-further-down",
    });
    assert.equal(fourth.status, 201);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// Display names
// ---------------------------------------------------------------------------

test("displayName defaults to the id, and a supplied one is trimmed and stored", { skip }, async () => {
  const actor = await existingAccount();
  const server = await boot();
  try {
    const signedIn = await signIn(server.baseUrl, actor.id, actor.password);

    const bare = freshId("bare");
    const withoutName = await createUser(server.baseUrl, signedIn.cookie, { user: bare, password: PASSWORD });
    assert.equal(withoutName.status, 201);
    assert.deepEqual(withoutName.body, { user: { id: bare, displayName: bare } });
    assert.equal((await userRows(bare))[0]!.display_name, bare, "the id is the stored default, not a blank");

    // Blank is the same fact as absent: a name made of spaces is not a name.
    const blank = freshId("blank");
    const withBlankName = await createUser(server.baseUrl, signedIn.cookie, {
      user: blank,
      password: PASSWORD,
      displayName: "   ",
    });
    assert.equal(withBlankName.status, 201);
    assert.deepEqual(withBlankName.body, { user: { id: blank, displayName: blank } });

    const named = freshId("named");
    const withName = await createUser(server.baseUrl, signedIn.cookie, {
      user: named,
      password: PASSWORD,
      displayName: "  Grace Hopper  ",
    });
    assert.equal(withName.status, 201);
    assert.deepEqual(withName.body, { user: { id: named, displayName: "Grace Hopper" } });
    assert.equal((await userRows(named))[0]!.display_name, "Grace Hopper");

    // And it is the name the client actually reads back, not only the one in this reply.
    const session = await signIn(server.baseUrl, named, PASSWORD);
    assert.equal(session.status, 200);
    const me = await send(server.baseUrl, "/me", { cookie: session.cookie });
    assert.deepEqual(me.body, { id: named, displayName: "Grace Hopper" });
  } finally {
    server.close();
  }
});
