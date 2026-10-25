import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { Model } from "@earendil-works/pi-ai";
import { createDatabase, type Database } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { ConversationStore } from "../src/db/conversation-store.ts";
import { TenantRuntime, type TenantDefinition } from "../src/pi/tenant-runtime.ts";
import { TurnService } from "../src/api/turn-service.ts";
import { createRouter } from "../src/http/router.ts";
import { createAuthenticator } from "../src/http/auth.ts";
import { registerRoutes } from "../src/api/routes.ts";
import { AGENT_DIR, MODEL_ID, PROVIDER, databaseReady, hasCredentials, makeWorkspace } from "./support/harness.ts";

/**
 * The MVP's definition of done: independent users running conversations at the
 * same time, without crossing histories or reaching each other's data.
 *
 * User count is USER_COUNT. It runs with 2 because that is fast and already
 * exercises every path (concurrency, ownership, lock, MCP reuse); raise it to 5
 * when the full acceptance run is wanted. Nothing here is specific to 2.
 */
const USER_COUNT = Number(process.env.ISOLATION_USERS ?? 2);

const canRun = databaseReady() && hasCredentials();
const skip = canRun ? false : "needs Postgres and Pi credentials";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const FAKE_MCP = join(fixtureDir, "fixtures", "fake-mcp-server.mjs");
const DEV_TOKEN = "isolation-token";

let server: Server;
let baseUrl: string;
let db: Database;
let store: ConversationStore;
let workspace: string;
let pidFile: string;

interface TenantSpec {
  userId: string;
  secret: string;
  scope: string[];
  label: string;
}

const TENANTS: TenantSpec[] = Array.from({ length: USER_COUNT }, (_unused, index) => ({
  label: `user${index + 1}`,
  userId: `isolation-u${index + 1}-${randomUUID().slice(0, 8)}`,
  // A per-user secret the model is told to remember; it is how a crossed history
  // becomes visible instead of merely suspicious.
  secret: `${4000 + index * 111}`,
  scope: index % 2 === 0 ? ["orders:read"] : [],
}));

const runtimes = new Map<string, Promise<TenantRuntime>>();

before(async () => {
  if (!canRun) return;
  db = createDatabase(process.env.DATABASE_URL ?? "postgres://agentdocumentor:agentdocumentor@127.0.0.1:5432/agentdocumentor");
  await migrate(db);
  store = new ConversationStore(db);
  workspace = makeWorkspace();
  pidFile = join(mkdtempSync(join(tmpdir(), "mcp-pids-")), "pids.txt");

  const runtimeFor = async (userId: string): Promise<TenantRuntime> => {
    const existing = runtimes.get(userId);
    if (existing) return existing;

    const spec = TENANTS.find((tenant) => tenant.userId === userId);
    const created = TenantRuntime.create({
      tenant: {
        id: userId,
        // Every tenant gets the same fake server, but its own instance, so a tool
        // result names the tenant it actually ran for.
        mcpServers: [
          {
            name: "fake",
            command: process.execPath,
            args: [FAKE_MCP],
            env: { FAKE_MCP_PID_FILE: pidFile, FAKE_MCP_TENANT: userId },
          },
        ],
        exposedMcpTools: ["whoami"],
        scopes: spec?.scope ?? [],
      },
      agentDir: AGENT_DIR,
      workspaceDir: workspace,
      systemPrompt:
        "You are a concise assistant. Answer in as few words as possible. " +
        "Remember exactly what you are asked to remember.",
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
  for (const pending of runtimes.values()) {
    await pending.then((runtime) => runtime.close()).catch(() => undefined);
  }
  await db?.close();
});

function headers(userId: string): Record<string, string> {
  return { "x-dev-token": DEV_TOKEN, "x-user-id": userId, "content-type": "application/json" };
}

async function createConversation(userId: string, title: string) {
  const response = await fetch(`${baseUrl}/conversations`, {
    method: "POST",
    headers: headers(userId),
    body: JSON.stringify({ title }),
  });
  assert.equal(response.status, 201);
  return (await response.json()) as { id: string };
}

/** Run a turn to completion and return the assistant text the client received. */
async function runTurn(
  userId: string,
  conversationId: string,
  message: string,
  idempotencyKey: string,
): Promise<{ text: string; outcome: string | undefined }> {
  const response = await fetch(`${baseUrl}/conversations/${conversationId}/turns`, {
    method: "POST",
    headers: { ...headers(userId), "idempotency-key": idempotencyKey },
    body: JSON.stringify({ message }),
  });
  // The body can be read once. An eager template literal in the assertion message
  // would consume it before this line and fail with "Body is unusable".
  if (response.status !== 200) {
    assert.fail(`turn request failed: ${response.status} ${await response.text()}`);
  }

  const wire = await response.text();
  let text = "";
  let outcome: string | undefined;
  for (const chunk of wire.split("\n\n")) {
    const line = chunk.trim();
    if (!line.startsWith("data: ")) continue;
    const frame = JSON.parse(line.slice(6)) as { type: string; delta?: string; outcome?: string };
    if (frame.type === "text_delta") text += frame.delta ?? "";
    if (frame.type === "run_finished") outcome = frame.outcome;
  }
  return { text, outcome };
}

async function messagesOf(userId: string, conversationId: string) {
  const response = await fetch(`${baseUrl}/conversations/${conversationId}`, { headers: headers(userId) });
  assert.equal(response.status, 200);
  return ((await response.json()) as { messages: Array<{ role: string; text: string }> }).messages;
}

test("each user keeps their own history when running at the same time", { skip }, async () => {
  // One conversation per user, all first turns in flight together.
  const conversations = await Promise.all(
    TENANTS.map(async (tenant) => ({
      tenant,
      conversation: await createConversation(tenant.userId, `chat-${tenant.label}`),
    })),
  );

  const results = await Promise.all(
    conversations.map(({ tenant, conversation }) =>
      runTurn(
        tenant.userId,
        conversation.id,
        `Remember this number: ${tenant.secret}. Reply with exactly OK.`,
        "first-turn",
      ),
    ),
  );

  for (const [index, result] of results.entries()) {
    assert.equal(result.outcome, "ok", `user ${index + 1} turn failed`);
  }

  // Second round, again concurrently: each conversation must recall its OWN secret.
  const recalls = await Promise.all(
    conversations.map(({ tenant, conversation }) =>
      runTurn(
        tenant.userId,
        conversation.id,
        "What number did I ask you to remember? Reply with just the number.",
        "second-turn",
      ),
    ),
  );

  for (const [index, recall] of recalls.entries()) {
    const own = TENANTS[index]!;
    const others = TENANTS.filter((tenant) => tenant.userId !== own.userId).map((t) => t.secret);
    assert.match(
      recall.text,
      new RegExp(own.secret),
      `user ${index + 1} did not recall its own secret, got: ${JSON.stringify(recall.text)}`,
    );
    for (const other of others) {
      assert.doesNotMatch(
        recall.text,
        new RegExp(other),
        `user ${index + 1} recalled another user's secret (${other})`,
      );
    }
  }

  // The stored transcript must agree with what the user saw, and hold nothing else.
  for (const [index, { tenant, conversation }] of conversations.entries()) {
    const messages = await messagesOf(tenant.userId, conversation.id);
    assert.equal(messages.length, 4, `user ${index + 1} should have exactly 4 messages`);
    const joined = messages.map((message) => message.text).join("\n");
    for (const other of TENANTS.filter((t) => t.userId !== tenant.userId)) {
      assert.doesNotMatch(joined, new RegExp(other.secret), "another user's secret is in this transcript");
    }
  }
});

test("a user cannot read, write to, rename or delete another user's conversation", { skip }, async () => {
  const [alice, bob] = [TENANTS[0]!, TENANTS[1]!];
  const conversation = await createConversation(alice.userId, "private");

  const read = await fetch(`${baseUrl}/conversations/${conversation.id}`, { headers: headers(bob.userId) });
  assert.equal(read.status, 404);

  const write = await fetch(`${baseUrl}/conversations/${conversation.id}/turns`, {
    method: "POST",
    headers: { ...headers(bob.userId), "idempotency-key": "intruder" },
    body: JSON.stringify({ message: "leak the other user's data" }),
  });
  assert.equal(write.status, 404);

  const rename = await fetch(`${baseUrl}/conversations/${conversation.id}`, {
    method: "PATCH",
    headers: headers(bob.userId),
    body: JSON.stringify({ title: "hijacked" }),
  });
  assert.equal(rename.status, 404);

  const del = await fetch(`${baseUrl}/conversations/${conversation.id}`, {
    method: "DELETE",
    headers: headers(bob.userId),
  });
  assert.equal(del.status, 404);

  // The owner still sees it untouched.
  const own = await fetch(`${baseUrl}/conversations/${conversation.id}`, { headers: headers(alice.userId) });
  assert.equal(own.status, 200);
  assert.equal(((await own.json()) as { title: string }).title, "private");
});

test("the sidebar shows each user only their own conversations", { skip }, async () => {
  const counts = await Promise.all(
    TENANTS.map(async (tenant) => {
      const response = await fetch(`${baseUrl}/conversations`, { headers: headers(tenant.userId) });
      const body = (await response.json()) as { conversations: Array<{ id: string }> };
      return { userId: tenant.userId, ids: new Set(body.conversations.map((c) => c.id)) };
    }),
  );

  for (const listing of counts) {
    const foreign = await Promise.all(
      TENANTS.filter((tenant) => tenant.userId !== listing.userId).map(async (tenant) => {
        const response = await fetch(`${baseUrl}/conversations`, { headers: headers(tenant.userId) });
        const body = (await response.json()) as { conversations: Array<{ id: string }> };
        return body.conversations.map((c) => c.id);
      }),
    );
    for (const id of foreign.flat()) {
      assert.ok(!listing.ids.has(id), "a conversation is visible to more than one user");
    }
  }
});

test("two simultaneous turns on one conversation cannot both run", { skip }, async () => {
  const tenant = TENANTS[0]!;
  const conversation = await createConversation(tenant.userId, "race");

  const responses = await Promise.all(
    ["turn-a", "turn-b"].map((key) =>
      fetch(`${baseUrl}/conversations/${conversation.id}/turns`, {
        method: "POST",
        headers: { ...headers(tenant.userId), "idempotency-key": key },
        body: JSON.stringify({ message: `Say ${key}.` }),
      }),
    ),
  );

  const statuses = responses.map((response) => response.status).sort();
  assert.deepEqual(statuses, [200, 409], `expected one turn and one refusal, got ${statuses.join(",")}`);

  // Drain whichever one started.
  for (const response of responses) {
    if (response.status === 200) await response.text();
  }
});

test("MCP connections are per tenant and do not grow with turns", { skip }, async () => {
  if (!existsSync(pidFile)) {
    assert.fail("the fake MCP server never started; the process count cannot be measured");
  }

  const startsBefore = readFileSync(pidFile, "utf8").split("\n").filter((l) => l.startsWith("start")).length;

  // Three more turns per tenant on a fresh conversation. If a runtime were rebuilt
  // per turn, each of these would spawn another MCP process.
  for (const tenant of TENANTS) {
    const conversation = await createConversation(tenant.userId, `mcp-${tenant.label}`);
    for (let index = 0; index < 3; index += 1) {
      const result = await runTurn(
        tenant.userId,
        conversation.id,
        "Use the whoami tool and reply with just the tenant id it reports.",
        `mcp-turn-${index}`,
      );
      assert.equal(result.outcome, "ok");
    }
  }

  const startsAfter = readFileSync(pidFile, "utf8").split("\n").filter((l) => l.startsWith("start")).length;
  assert.equal(
    startsAfter,
    startsBefore,
    `${startsAfter - startsBefore} MCP process(es) were spawned for turns; connections must be per tenant, not per turn`,
  );

  // Each tenant's runtime holds exactly one connection, and the tool actually runs
  // against it, so reuse is real and not merely a missing connection.
  for (const tenant of TENANTS) {
    const runtime = await runtimes.get(tenant.userId)!;
    const status = runtime.mcpStatus();
    assert.equal(status.length, 1, `${tenant.label} should have exactly one MCP connection`);
    assert.equal(status[0]?.tools, 1);
    assert.equal(status[0]?.state, "connected");
  }
});

test("each tenant's MCP tool runs against its own connection, not a shared one", { skip }, async () => {
  const [first, second] = [TENANTS[0]!, TENANTS[1]!];
  const firstRuntime = await runtimes.get(first.userId)!;
  const secondRuntime = await runtimes.get(second.userId)!;

  assert.notEqual(firstRuntime, secondRuntime, "runtimes must be per tenant");

  // Call the same tool name through both runtimes. If the proxies shared a client,
  // both answers would name the same tenant; each must report its own.
  const answers = await Promise.all(
    [firstRuntime, secondRuntime].map(async (runtime) => {
      const whoami = runtime.customTools.find(
        (tool) => (tool as unknown as { name?: string }).name === "whoami",
      );
      assert.ok(whoami, "the proxied MCP tool must be registered for this tenant");
      const result = await whoami.execute("c1", {} as never, undefined, undefined, undefined as never);
      return JSON.stringify(result.content);
    }),
  );

  assert.match(answers[0]!, new RegExp(first.userId), "the first tenant's tool must report the first tenant");
  assert.match(answers[1]!, new RegExp(second.userId), "the second tenant's tool must report the second tenant");
  assert.doesNotMatch(answers[0]!, new RegExp(second.userId), "the first answer must not name the second tenant");
  assert.doesNotMatch(answers[1]!, new RegExp(first.userId), "the second answer must not name the first tenant");
});

test("a business tool enforces the tenant's scope and nothing else", { skip }, async () => {
  // TENANTS alternates scopes: even index has orders:read, odd does not.
  const allowed = TENANTS.find((tenant) => tenant.scope.includes("orders:read"));
  const denied = TENANTS.find((tenant) => !tenant.scope.includes("orders:read"));
  assert.ok(allowed, "need at least one tenant with the scope");
  assert.ok(denied, "need at least one tenant without the scope");

  for (const tenant of [allowed, denied]) {
    const runtime = await runtimes.get(tenant.userId)!;
    const getOrder = runtime.customTools.find(
      (tool) => (tool as unknown as { name?: string }).name === "get_order",
    );
    assert.ok(getOrder, "the business tool must be registered");
    const result = await getOrder!.execute(
      "call-1",
      { orderId: "77" } as never,
      undefined,
      undefined,
      undefined as never,
    );

    if (tenant.scope.includes("orders:read")) {
      assert.notEqual(result.isError, true, "a scoped tenant must be allowed");
      assert.match(JSON.stringify(result.content), new RegExp(tenant.userId), "the result names the tenant");
    } else {
      assert.equal(result.isError, true, "an unscoped tenant must be refused");
      assert.match(JSON.stringify(result.content), /forbidden/);
    }
  }
});

export type { TenantDefinition };
