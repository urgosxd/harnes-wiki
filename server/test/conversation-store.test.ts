import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Database } from "../src/db/pool.ts";
import { ConversationStore, type Conversation } from "../src/db/conversation-store.ts";
import { databaseAvailable, openTestDatabase, testUser } from "./support/db.ts";

const available = await databaseAvailable();
const skip = available ? false : "Postgres is not reachable (docker compose up -d postgres)";

let db: Database;
let store: ConversationStore;

before(async () => {
  if (!available) return;
  db = await openTestDatabase();
  store = new ConversationStore(db);
});

after(async () => {
  if (db) await db.close();
});

async function newConversation(userId: string, title?: string): Promise<Conversation> {
  return store.create({
    id: randomUUID(),
    userId,
    piSessionId: randomUUID(),
    title: title ?? null,
  });
}

function userEntry(text: string): SessionEntry {
  return {
    type: "message",
    id: randomUUID().slice(0, 8),
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: text, timestamp: Date.now() },
  } as SessionEntry;
}

test("a conversation is stored with its owner and Pi session id", { skip }, async () => {
  const userId = testUser("owner");
  const conv = await newConversation(userId, "First chat");

  assert.equal(conv.userId, userId);
  assert.equal(conv.title, "First chat");
  assert.match(conv.piSessionId, /^[0-9a-f-]{36}$/);
  assert.equal(conv.archivedAt, null);
});

test("ownership is folded into the lookup, not checked afterwards", { skip }, async () => {
  const alice = testUser("alice");
  const bob = testUser("bob");
  const conv = await newConversation(alice);

  assert.ok(await store.findOwned(conv.id, alice), "the owner must find it");
  assert.equal(
    await store.findOwned(conv.id, bob),
    undefined,
    "a foreign conversation must be indistinguishable from a missing one",
  );
});

test("the sidebar lists only the user's own non-archived conversations", { skip }, async () => {
  const alice = testUser("alice");
  const bob = testUser("bob");
  const first = await newConversation(alice, "A");
  const second = await newConversation(alice, "B");
  await newConversation(bob, "not alice's");

  await store.archive(first.id, alice);

  const listed = await store.listForUser(alice);
  assert.deepEqual(
    listed.map((c) => c.id),
    [second.id],
    "archived and foreign conversations must not appear",
  );
  assert.ok((await store.listForUser(bob)).every((c) => c.userId === bob));
});

test("rename only affects the owner's conversation", { skip }, async () => {
  const alice = testUser("alice");
  const bob = testUser("bob");
  const conv = await newConversation(alice, "old");

  assert.equal(await store.rename(conv.id, bob, "hijacked"), undefined);
  const renamed = await store.rename(conv.id, alice, "new");
  assert.equal(renamed?.title, "new");
});

test("entries come back in append order", { skip }, async () => {
  const conv = await newConversation(testUser("order"));
  const entries = [userEntry("one"), userEntry("two"), userEntry("three")];
  await store.append(conv.id, entries);

  const read = await store.read(conv.id);
  assert.equal(read.length, 3);
  assert.deepEqual(
    read.map((e) => (e.type === "message" && e.message.role === "user" ? e.message.content : null)),
    ["one", "two", "three"],
  );
  assert.equal(await store.entryCount(conv.id), 3);
});

test("appending in two calls continues the sequence instead of restarting it", { skip }, async () => {
  const conv = await newConversation(testUser("append"));
  await store.append(conv.id, [userEntry("a"), userEntry("b")]);
  await store.append(conv.id, [userEntry("c")]);

  assert.equal(await store.entryCount(conv.id), 3);
  const read = await store.read(conv.id);
  assert.deepEqual(
    read.map((e) => (e.type === "message" && e.message.role === "user" ? e.message.content : null)),
    ["a", "b", "c"],
  );
});

test("the transcript is append-only: the database refuses updates and deletes", { skip }, async () => {
  const conv = await newConversation(testUser("immutable"));
  await store.append(conv.id, [userEntry("original")]);

  await assert.rejects(
    db.query("UPDATE session_entries SET entry = '{}'::jsonb WHERE conversation_id = $1", [conv.id]),
    /append-only/,
    "an UPDATE must be rejected by the database, not merely avoided by the app",
  );
  await assert.rejects(
    db.query("DELETE FROM session_entries WHERE conversation_id = $1", [conv.id]),
    /append-only/,
    "a DELETE must be rejected by the database",
  );

  const read = await store.read(conv.id);
  assert.equal(read.length, 1, "the transcript must be unchanged after the refused writes");
});

test("an empty append is a no-op", { skip }, async () => {
  const conv = await newConversation(testUser("empty"));
  await store.append(conv.id, []);
  assert.equal(await store.entryCount(conv.id), 0);
});

test("the same idempotency key never starts a second run", { skip }, async () => {
  const conv = await newConversation(testUser("idem"));
  const key = "turn-1";

  const first = await store.startRun({ id: randomUUID(), conversationId: conv.id, idempotencyKey: key });
  const second = await store.startRun({ id: randomUUID(), conversationId: conv.id, idempotencyKey: key });

  assert.equal(first.status, "created");
  assert.equal(second.status, "replay", "the second attempt must not create a run");
  assert.equal(second.run.id, first.run.id, "it must return the original run");
  assert.equal(second.run.status, "running");
});

test("a race on one idempotency key produces exactly one run", { skip }, async () => {
  const conv = await newConversation(testUser("race"));
  const key = "turn-simultaneous";

  const attempts = await Promise.all(
    Array.from({ length: 8 }, () =>
      store.startRun({ id: randomUUID(), conversationId: conv.id, idempotencyKey: key }),
    ),
  );

  const created = attempts.filter((a) => a.status === "created");
  assert.equal(created.length, 1, `exactly one run must be created, got ${created.length}`);
  assert.equal(
    new Set(attempts.map((a) => (a.status === "busy" ? "none" : a.run.id))).size,
    1,
    "all attempts must agree on the run id",
  );

  const rows = await db.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM agent_runs WHERE conversation_id = $1",
    [conv.id],
  );
  assert.equal(rows[0]?.count, "1");
});

test("a second turn on a busy conversation is refused, not run in parallel", { skip }, async () => {
  const conv = await newConversation(testUser("busy"));

  const first = await store.startRun({
    id: randomUUID(),
    conversationId: conv.id,
    idempotencyKey: "turn-1",
  });
  assert.equal(first.status, "created");

  // Different key: this is a second turn, not a replay.
  const second = await store.startRun({
    id: randomUUID(),
    conversationId: conv.id,
    idempotencyKey: "turn-2",
  });

  assert.equal(second.status, "busy", "a second turn must be refused while one is running");
  if (second.status !== "busy") throw new Error("unreachable");
  assert.equal(second.running?.idempotencyKey, "turn-1", "it must name the run that holds the lock");
});

test("the conversation frees up once the running turn finishes", { skip }, async () => {
  const conv = await newConversation(testUser("freed"));
  const first = await store.startRun({ id: randomUUID(), conversationId: conv.id, idempotencyKey: "a" });
  assert.equal(first.status, "created");
  if (first.status !== "created") throw new Error("unreachable");

  await store.finishRun(first.run.id, { status: "ok" });

  const next = await store.startRun({ id: randomUUID(), conversationId: conv.id, idempotencyKey: "b" });
  assert.equal(next.status, "created", "a finished run must not keep the conversation locked");
});

test("a race of distinct turns on one conversation produces exactly one run", { skip }, async () => {
  const conv = await newConversation(testUser("turn-race"));

  // Eight simultaneous first-turns with distinct keys. Without the partial unique
  // index this is the shape that corrupts a transcript: each turn would rebuild
  // from the same snapshot and append.
  const attempts = await Promise.all(
    Array.from({ length: 8 }, (_unused, index) =>
      store.startRun({
        id: randomUUID(),
        conversationId: conv.id,
        idempotencyKey: `turn-${index}`,
      }),
    ),
  );

  const created = attempts.filter((a) => a.status === "created");
  assert.equal(created.length, 1, `exactly one turn may start, got ${created.length}`);

  const rows = await db.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM agent_runs WHERE conversation_id = $1",
    [conv.id],
  );
  assert.equal(rows[0]?.count, "1", "the database must hold one run, not eight");
});

test("different conversations may reuse the same idempotency key", { skip }, async () => {
  const user = testUser("reuse");
  const a = await newConversation(user);
  const b = await newConversation(user);

  const first = await store.startRun({ id: randomUUID(), conversationId: a.id, idempotencyKey: "1" });
  const second = await store.startRun({ id: randomUUID(), conversationId: b.id, idempotencyKey: "1" });

  assert.equal(first.status, "created");
  assert.equal(second.status, "created", "the uniqueness is per conversation, not global");
});

test("a run records its outcome, tokens and cost", { skip }, async () => {
  const conv = await newConversation(testUser("outcome"));
  const startedResult = await store.startRun({
    id: randomUUID(),
    conversationId: conv.id,
    idempotencyKey: "k",
  });

  assert.equal(startedResult.status, "created");
  if (startedResult.status !== "created") throw new Error("unreachable");
  await store.finishRun(startedResult.run.id, {
    status: "error",
    stopReason: "error",
    errorMessage: "400 bad model",
    totalTokens: 12,
    costTotal: 0.000001,
  });

  const finished = await store.findRun(startedResult.run.id);
  assert.equal(finished?.status, "error");
  assert.equal(finished?.stopReason, "error");
  assert.equal(finished?.errorMessage, "400 bad model");
  assert.equal(finished?.totalTokens, 12);
  assert.equal(finished?.costTotal, 0.000001);
});

test("runs left running by a crash are marked interrupted", { skip }, async () => {
  const conv = await newConversation(testUser("crash"));
  const startedResult = await store.startRun({
    id: randomUUID(),
    conversationId: conv.id,
    idempotencyKey: "crashed",
  });

  assert.equal(startedResult.status, "created");
  if (startedResult.status !== "created") throw new Error("unreachable");

  const fixed = await store.failInterruptedRuns();
  assert.ok(fixed >= 1, "the interrupted run must be swept");

  const run = await store.findRun(startedResult.run.id);
  assert.equal(run?.status, "error");
  assert.match(run?.errorMessage ?? "", /server stopped/);
});

test("tenant MCP configuration and scopes are read per user", { skip }, async () => {
  const user = testUser("tenant");
  await db.query(
    `INSERT INTO tenant_mcp (user_id, server_name, command, args, exposed_tools)
     VALUES ($1, 'orders', 'node', '["mcp.js"]'::jsonb, '["get_order"]'::jsonb)`,
    [user],
  );
  await db.query("INSERT INTO tenant_scopes (user_id, scope) VALUES ($1, 'orders:read')", [user]);

  const servers = await store.listMcpServers(user);
  assert.equal(servers.length, 1);
  assert.equal(servers[0]?.command, "node");
  assert.deepEqual(servers[0]?.exposedTools, ["get_order"]);
  assert.deepEqual(await store.listScopes(user), ["orders:read"]);

  assert.deepEqual(await store.listMcpServers(testUser("other")), [], "another user sees nothing");
});

test("a disabled MCP server is not handed to the runtime", { skip }, async () => {
  const user = testUser("disabled");
  await db.query(
    `INSERT INTO tenant_mcp (user_id, server_name, command, enabled)
     VALUES ($1, 'off', 'node', false)`,
    [user],
  );
  assert.deepEqual(await store.listMcpServers(user), []);
});

test("deleting a conversation removes its transcript and runs", { skip }, async () => {
  const conv = await newConversation(testUser("cascade"));
  await store.append(conv.id, [userEntry("x")]);
  await store.startRun({ id: randomUUID(), conversationId: conv.id, idempotencyKey: "k" });

  // The API's delete archives; a hard delete is the cascade path.
  await db.query("DELETE FROM conversations WHERE id = $1", [conv.id]);

  const entries = await db.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM session_entries WHERE conversation_id = $1",
    [conv.id],
  );
  const runs = await db.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM agent_runs WHERE conversation_id = $1",
    [conv.id],
  );
  assert.equal(entries[0]?.count, "0");
  assert.equal(runs[0]?.count, "0");
});

test("migrations are idempotent", { skip }, async () => {
  const { migrate } = await import("../src/db/migrate.ts");
  const again = await migrate(db);
  assert.deepEqual(again.applied, [], "a second run must apply nothing");
  assert.ok(again.skipped.includes("001_init.sql"));
});
