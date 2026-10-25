import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { Model } from "@earendil-works/pi-ai";
import { createDatabase, type Database } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { ConversationStore } from "../src/db/conversation-store.ts";
import { TenantRuntime } from "../src/pi/tenant-runtime.ts";
import { TurnService } from "../src/api/turn-service.ts";
import { createRouter } from "../src/http/router.ts";
import { createAuthenticator } from "../src/http/auth.ts";
import { registerRoutes } from "../src/api/routes.ts";
import { projectMessages } from "../src/api/routes.ts";
import { AGENT_DIR, MODEL_ID, PROVIDER, databaseReady, hasCredentials, makeWorkspace, testUser } from "./support/harness.ts";

const canRun = databaseReady() && hasCredentials();
const skip = canRun ? false : "needs Postgres and Pi credentials";

const DEV_TOKEN = "test-token";
let server: Server;
let baseUrl: string;
let db: Database;
let store: ConversationStore;
let workspace: string;

before(async () => {
  if (!canRun) return;
  db = createDatabase(process.env.DATABASE_URL ?? "postgres://agentdocumentor:agentdocumentor@127.0.0.1:5432/agentdocumentor");
  await migrate(db);
  store = new ConversationStore(db);
  workspace = makeWorkspace();

  const runtimes = new Map<string, Promise<TenantRuntime>>();
  const runtimeFor = (userId: string) => {
    const existing = runtimes.get(userId);
    if (existing) return existing;
    const created = TenantRuntime.create({
      tenant: { id: userId, mcpServers: [], exposedMcpTools: [], scopes: ["orders:read"] },
      agentDir: AGENT_DIR,
      workspaceDir: workspace,
      systemPrompt: "You are concise. Answer in one short sentence.",
    });
    runtimes.set(userId, created);
    return created;
  };

  const modelFor = (runtime: TenantRuntime): Model<never> => {
    const model = runtime.modelRuntime.getModel(PROVIDER, MODEL_ID);
    if (!model) throw new Error("model unavailable");
    return model as unknown as Model<never>;
  };

  const turns = new TurnService({
    store,
    runtimeFor,
    workspaceDir: workspace,
    agentDir: AGENT_DIR,
    modelFor,
    thinkingLevel: "off",
  });

  const router = createRouter({ authenticate: createAuthenticator({ devToken: DEV_TOKEN }) });
  registerRoutes(router, { store, turns });
  server = await router.listen(0, "127.0.0.1");
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

after(async () => {
  server?.close();
  await db?.close();
});

function headers(userId: string): Record<string, string> {
  return { "x-dev-token": DEV_TOKEN, "x-user-id": userId, "content-type": "application/json" };
}

async function createConversation(userId: string, title?: string) {
  const response = await fetch(`${baseUrl}/conversations`, {
    method: "POST",
    headers: headers(userId),
    body: JSON.stringify(title ? { title } : {}),
  });
  assert.equal(response.status, 201);
  return (await response.json()) as { id: string; title: string | null };
}

/** Read an SSE body and return the frames, in order. */
async function readFrames(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  return text
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice("data: ".length)) as Record<string, unknown>);
}

test("an unauthenticated request is refused", { skip }, async () => {
  const response = await fetch(`${baseUrl}/conversations`);
  assert.equal(response.status, 401);
});

test("a wrong token is refused", { skip }, async () => {
  const response = await fetch(`${baseUrl}/conversations`, {
    headers: { "x-dev-token": "wrong", "x-user-id": "alice" },
  });
  assert.equal(response.status, 401);
});

test("a conversation is created and listed for its owner only", { skip }, async () => {
  const alice = testUser("alice");
  const bob = testUser("bob");
  const conv = await createConversation(alice, "First");

  const mine = (await (await fetch(`${baseUrl}/conversations`, { headers: headers(alice) })).json()) as {
    conversations: Array<{ id: string }>;
  };
  assert.ok(mine.conversations.some((c) => c.id === conv.id));

  const theirs = (await (await fetch(`${baseUrl}/conversations`, { headers: headers(bob) })).json()) as {
    conversations: Array<{ id: string }>;
  };
  assert.equal(theirs.conversations.length, 0, "another user must see nothing");
});

test("reading someone else's conversation answers 404, not 403", { skip }, async () => {
  const alice = testUser("alice");
  const bob = testUser("bob");
  const conv = await createConversation(alice);

  const response = await fetch(`${baseUrl}/conversations/${conv.id}`, { headers: headers(bob) });
  assert.equal(
    response.status,
    404,
    "a 403 would confirm the conversation exists and belongs to someone else",
  );
});

test("rename and archive only affect the owner", { skip }, async () => {
  const alice = testUser("alice");
  const bob = testUser("bob");
  const conv = await createConversation(alice, "old");

  const hijack = await fetch(`${baseUrl}/conversations/${conv.id}`, {
    method: "PATCH",
    headers: headers(bob),
    body: JSON.stringify({ title: "hijacked" }),
  });
  assert.equal(hijack.status, 404);

  const rename = await fetch(`${baseUrl}/conversations/${conv.id}`, {
    method: "PATCH",
    headers: headers(alice),
    body: JSON.stringify({ title: "renamed" }),
  });
  assert.equal(rename.status, 200);
  assert.equal(((await rename.json()) as { title: string }).title, "renamed");

  const del = await fetch(`${baseUrl}/conversations/${conv.id}`, {
    method: "DELETE",
    headers: headers(bob),
  });
  assert.equal(del.status, 404, "a foreign delete must not succeed");

  const delOwn = await fetch(`${baseUrl}/conversations/${conv.id}`, {
    method: "DELETE",
    headers: headers(alice),
  });
  assert.equal(delOwn.status, 204);
});

test("a turn streams frames and the conversation keeps the reply", { skip }, async () => {
  const user = testUser("turn");
  const conv = await createConversation(user, "chat");

  const response = await fetch(`${baseUrl}/conversations/${conv.id}/turns`, {
    method: "POST",
    headers: { ...headers(user), "idempotency-key": "t1" },
    body: JSON.stringify({ message: "Say HELLO and nothing else." }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.ok(response.headers.get("x-run-id"), "the run id must be exposed to the client");

  const frames = await readFrames(response);
  assert.equal(frames[0]?.type, "run_started");
  assert.ok(
    frames.some((f) => f.type === "text_delta"),
    "the client must receive text deltas",
  );
  assert.equal(frames.at(-1)?.type, "run_finished", `last frame was ${JSON.stringify(frames.at(-1))}`);

  const detail = (await (await fetch(`${baseUrl}/conversations/${conv.id}`, { headers: headers(user) })).json()) as {
    messages: Array<{ role: string; text: string }>;
  };
  assert.equal(detail.messages.length, 2, "the transcript must hold the user turn and the reply");
  assert.equal(detail.messages[0]?.role, "user");
  assert.equal(detail.messages[1]?.role, "assistant");
  assert.match(detail.messages[1]?.text ?? "", /HELLO/i);
});

test("a turn without an Idempotency-Key is refused", { skip }, async () => {
  const user = testUser("nokey");
  const conv = await createConversation(user);

  const response = await fetch(`${baseUrl}/conversations/${conv.id}/turns`, {
    method: "POST",
    headers: headers(user),
    body: JSON.stringify({ message: "hi" }),
  });
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { error: string }).error, "idempotency_key_required");
});

test("reusing an idempotency key does not start a second turn", { skip }, async () => {
  const user = testUser("replay");
  const conv = await createConversation(user);
  const send = () =>
    fetch(`${baseUrl}/conversations/${conv.id}/turns`, {
      method: "POST",
      headers: { ...headers(user), "idempotency-key": "same" },
      body: JSON.stringify({ message: "Say ONE." }),
    });

  const first = await send();
  assert.equal(first.status, 200);
  await first.text();

  const second = await send();
  assert.equal(second.status, 200);
  const body = (await second.json()) as { error: string; runId: string };
  assert.equal(body.error, "duplicate_turn");
  assert.ok(body.runId, "the client must learn which run it already has");

  const detail = (await (await fetch(`${baseUrl}/conversations/${conv.id}`, { headers: headers(user) })).json()) as {
    messages: unknown[];
  };
  assert.equal(detail.messages.length, 2, "the second request must not append another turn");
});

test("a second turn on a busy conversation answers 409", { skip }, async () => {
  const user = testUser("busy");
  const conv = await createConversation(user);

  const first = fetch(`${baseUrl}/conversations/${conv.id}/turns`, {
    method: "POST",
    headers: { ...headers(user), "idempotency-key": "slow" },
    body: JSON.stringify({ message: "Write three sentences about the sea." }),
  });

  // Give the first turn a moment to take the lock.
  await new Promise((resolve) => setTimeout(resolve, 300));

  const second = await fetch(`${baseUrl}/conversations/${conv.id}/turns`, {
    method: "POST",
    headers: { ...headers(user), "idempotency-key": "other" },
    body: JSON.stringify({ message: "Say something else." }),
  });
  assert.equal(second.status, 409);
  assert.equal(((await second.json()) as { error: string }).error, "turn_in_progress");

  await (await first).text();
});

test("a turn against a foreign conversation answers 404", { skip }, async () => {
  const alice = testUser("alice");
  const bob = testUser("bob");
  const conv = await createConversation(alice);

  const response = await fetch(`${baseUrl}/conversations/${conv.id}/turns`, {
    method: "POST",
    headers: { ...headers(bob), "idempotency-key": "x" },
    body: JSON.stringify({ message: "hi" }),
  });
  assert.equal(response.status, 404);
});

test("an empty message is refused", { skip }, async () => {
  const user = testUser("empty");
  const conv = await createConversation(user);

  const response = await fetch(`${baseUrl}/conversations/${conv.id}/turns`, {
    method: "POST",
    headers: { ...headers(user), "idempotency-key": "e" },
    body: JSON.stringify({ message: "   " }),
  });
  assert.equal(response.status, 400);
});

test("the message projection hides Pi internals", () => {
  const projected = projectMessages([
    { type: "model_change" },
    { type: "thinking_level_change" },
    { type: "message", message: { role: "system", content: "hidden prompt" } },
    { type: "message", message: { role: "user", content: "hello" } },
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "hi there" }, { type: "thinking", thinking: "secret" }] },
    },
    { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "tool output" }] } },
  ]);

  assert.deepEqual(projected, [
    { id: "m0", role: "user", text: "hello" },
    { id: "m1", role: "assistant", text: "hi there" },
  ]);
});
