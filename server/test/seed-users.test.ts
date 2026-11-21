import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Database } from "../src/db/pool.ts";
import { createRouter } from "../src/http/router.ts";
import { createAuthenticator } from "../src/http/auth.ts";
import { registerRoutes } from "../src/api/routes.ts";
import type { ConversationStore } from "../src/db/conversation-store.ts";
import type { TurnService } from "../src/api/turn-service.ts";
import { DEFAULT_USER_IDS, parseDefaultUsers, seedDefaultUsers } from "../src/db/seed-users.ts";
import { databaseAvailable, openTestDatabase } from "./support/db.ts";

/**
 * The two accounts a fresh deployment gets (S5), against a real database.
 *
 * What this file pins that nothing inward can: which accounts end up in the `users`
 * table, that a second boot changes none of them, that a generated password is printed
 * exactly once and actually works, and that a malformed `DEFAULT_USERS` seeds NOTHING.
 * Sign-in goes through `POST /login`, so a password that is stored but does not verify —
 * the only failure an operator would never notice — fails here.
 *
 * This file owns `alice` and `bob` on the test database: it removes them before and
 * after, because "two accounts exist on a fresh database" is only observable when those
 * two ids are absent. No other suite uses them (they build ids from `testUser`).
 */
const available = await databaseAvailable();
const skip = available ? false : "needs a reachable Postgres (docker compose up -d postgres)";

/** Ids this file owns, as the module under test spells them. */
const SEEDED: readonly string[] = DEFAULT_USER_IDS;

const RAW = "alice:alicepass1,bob:bobpass12";

let db: Database;

before(async () => {
  if (!available) return;
  db = await openTestDatabase();
  await resetSeededAccounts();
});

after(async () => {
  if (!available) return;
  await resetSeededAccounts();
  await db.close();
});

async function resetSeededAccounts(): Promise<void> {
  await db.query("DELETE FROM users WHERE id = ANY($1::text[])", [SEEDED]);
}

async function seededRows(): Promise<Array<{ id: string; display_name: string; created_at: Date }>> {
  return db.query<{ id: string; display_name: string; created_at: Date }>(
    "SELECT id, display_name, created_at FROM users WHERE id = ANY($1::text[]) ORDER BY id",
    [SEEDED],
  );
}

interface Booted {
  baseUrl: string;
  close(): void;
}

/** Just enough server to attempt a login: the endpoint that reads what seeding stored. */
async function boot(): Promise<Booted> {
  const router = createRouter({ authenticate: createAuthenticator({ mode: "password", db }) });
  registerRoutes(router, {
    store: {} as unknown as ConversationStore,
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

/** Does this pair sign in right now? Returns the status so a caller can assert on it. */
async function loginStatus(baseUrl: string, user: string, password: string): Promise<number> {
  const response = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user, password }),
  });
  await response.text();
  return response.status;
}

/** The password a log line carries, or `undefined` when the line carries none. */
function loggedPassword(line: string): string | undefined {
  return /password="([^"]+)"/.exec(line)?.[1];
}

// ---------------------------------------------------------------------------
// The environment format
// ---------------------------------------------------------------------------

test("parseDefaultUsers trims entries, skips blanks and splits on the first colon", () => {
  assert.deepEqual(parseDefaultUsers(undefined), []);
  assert.deepEqual(parseDefaultUsers("   "), []);
  assert.deepEqual(parseDefaultUsers(" , , "), [], "an all-blank value means no accounts, so both get generated");

  assert.deepEqual(parseDefaultUsers(" alice:alicepass1 , , bob:bo:bpass12 "), [
    { id: "alice", password: "alicepass1" },
    // The password itself may contain a colon: only the FIRST one separates the pair.
    { id: "bob", password: "bo:bpass12" },
  ]);

  // A configuration error is named with the entry that caused it, because an operator
  // reading a failed boot has to be able to find the typo in their own value.
  assert.throws(() => parseDefaultUsers("alice:short"), /alice:short/);
  assert.throws(() => parseDefaultUsers("bad id:pw123456789"), /bad id:pw123456789/);
  assert.throws(() => parseDefaultUsers("noColon"), /noColon/);
  assert.throws(() => parseDefaultUsers("alice:alicepass1,alice:alicepass2"), /twice/);
});

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

test("DEFAULT_USERS creates both accounts, and both of them can sign in", { skip }, async () => {
  await resetSeededAccounts();
  const lines: string[] = [];

  const first = await seedDefaultUsers(db, { raw: RAW, log: (line) => lines.push(line) });
  assert.deepEqual(first.created, ["alice", "bob"]);

  const rows = await seededRows();
  assert.deepEqual(
    rows.map((row) => [row.id, row.display_name]),
    [
      ["alice", "alice"],
      ["bob", "bob"],
    ],
    "both accounts exist, each named after its id",
  );

  const server = await boot();
  try {
    assert.equal(await loginStatus(server.baseUrl, "alice", "alicepass1"), 200);
    assert.equal(await loginStatus(server.baseUrl, "bob", "bobpass12"), 200);
    // A supplied password is not a secret the server has to print: the operator wrote it.
    for (const password of ["alicepass1", "bobpass12"]) {
      assert.deepEqual(
        lines.filter((line) => line.includes(password)),
        [],
        "a password from DEFAULT_USERS must never be echoed into the log",
      );
    }
    // Two lines, one per account actually created.
    assert.equal(lines.length, 2, `expected one line per created account, got ${JSON.stringify(lines)}`);
  } finally {
    server.close();
  }
});

test("a second run creates nothing and never resets an existing password", { skip }, async () => {
  await resetSeededAccounts();
  assert.deepEqual((await seedDefaultUsers(db, { raw: RAW })).created, ["alice", "bob"]);
  const before = await seededRows();
  assert.equal(before.length, 2);

  // A redeploy with a DIFFERENT DEFAULT_USERS is the case that matters: the second run
  // must not become a credential reset for accounts that already exist.
  const second = await seedDefaultUsers(db, { raw: "alice:anotherpass1,bob:anotherpass2" });
  assert.deepEqual(second.created, [], "nothing exists to create");

  const rows = await seededRows();
  assert.equal(rows.length, 2, "two accounts, not four");
  assert.deepEqual(
    rows.map((row) => [row.id, row.created_at.toISOString()]),
    before.map((row) => [row.id, row.created_at.toISOString()]),
    "the existing rows must be untouched, timestamps included",
  );

  const server = await boot();
  try {
    assert.equal(await loginStatus(server.baseUrl, "alice", "alicepass1"), 200, "the original password still works");
    assert.equal(await loginStatus(server.baseUrl, "bob", "bobpass12"), 200);
    assert.equal(await loginStatus(server.baseUrl, "alice", "anotherpass1"), 401, "the new value must not have replaced it");
  } finally {
    server.close();
  }
});

test("generated passwords are logged once and actually authenticate", { skip }, async () => {
  await resetSeededAccounts();
  const lines: string[] = [];

  const first = await seedDefaultUsers(db, { log: (line) => lines.push(line) });
  assert.deepEqual(first.created, ["alice", "bob"]);
  assert.equal(lines.length, 2, `expected one line per created account, got ${JSON.stringify(lines)}`);

  const passwords = new Map<string, string>();
  for (const id of SEEDED) {
    const line = lines.find((candidate) => candidate.includes(`"${id}"`));
    assert.ok(line !== undefined, `expected a log line naming ${id}, got ${JSON.stringify(lines)}`);
    const password = loggedPassword(line);
    assert.ok(password !== undefined, `the line for ${id} must carry its generated password: ${line}`);
    passwords.set(id, password);
  }
  // One per account: the same password for both would make one leak break both.
  assert.equal(new Set(passwords.values()).size, 2);

  const server = await boot();
  try {
    for (const id of SEEDED) {
      assert.equal(
        await loginStatus(server.baseUrl, id, passwords.get(id)!),
        200,
        `${id} must be able to sign in with the password that was logged`,
      );
    }

    // The operator's copy is a one-time thing: a later boot must not print it again, or
    // every restart would put a live credential in a log that is kept and shipped.
    const secondLines: string[] = [];
    assert.deepEqual((await seedDefaultUsers(db, { log: (line) => secondLines.push(line) })).created, []);
    for (const password of passwords.values()) {
      assert.deepEqual(
        secondLines.filter((line) => line.includes(password)),
        [],
        "a generated password must never appear in a later boot's log",
      );
    }
  } finally {
    server.close();
  }
});

test("an invalid DEFAULT_USERS throws, names the entry and seeds nothing", { skip }, async () => {
  for (const raw of ["alice:short", "bad id:pw123456789", "noColon"]) {
    await resetSeededAccounts();

    await assert.rejects(
      () => seedDefaultUsers(db, { raw }),
      (error: unknown) => {
        assert.ok(error instanceof Error, `expected an Error for ${raw}, got ${String(error)}`);
        assert.ok(
          error.message.includes(raw),
          `the error must name the offending entry "${raw}", got "${error.message}"`,
        );
        return true;
      },
    );

    // A half-seeded deployment is worse than a failed boot: the transaction must leave
    // the table exactly as it was.
    assert.deepEqual(await seededRows(), [], `a rejected DEFAULT_USERS must create no account (raw: ${raw})`);
  }
});
