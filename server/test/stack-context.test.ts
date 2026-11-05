import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { proxyMcpTools, type TenantMcpServer } from "../src/pi/tenant-runtime.ts";
import { currentStackId, withStackContext } from "../src/pi/stack-context.ts";
import { Logger } from "../src/log.ts";
import { createRouter } from "../src/http/router.ts";
import { createAuthenticator } from "../src/http/auth.ts";
import { registerRoutes } from "../src/api/routes.ts";
import type { ConversationStore } from "../src/db/conversation-store.ts";
import type { TurnService } from "../src/api/turn-service.ts";

/**
 * The rule this file pins
 *
 * The Stack a tool call uses is, in order: a `stackId` the caller stated explicitly
 * ("si el usuario indica que se use otro se usará"), then the one the REQUEST named —
 * the `stackId` the link carried into the turn route — which is the fallback and the
 * only one. There is no stored default and no host binding to inherit:
 * `tenant_mcp.default_stack_id` is no longer read, and with no Stack from EITHER source
 * the call is REFUSED instead of leaving unscoped, because an unscoped call silently
 * reads whatever Stack the upstream happens to sit on. That is the 2026-10-28 incident:
 * the agent truthfully reported "0 pages" about a Stack the user had never heard of,
 * while their work sat elsewhere.
 *
 * An argument that differs from the turn's Stack used to be a contradiction the server
 * refused (S10 of `multitenant-stackId.md`). It is now the user's stated choice, so the
 * call proceeds on the argument — and because that is a divergence from what the link
 * says, it is made non-silent through one structured log record (Manager decision D1).
 *
 * ## Why the context is not a field on the runtime
 *
 * The tenant runtime is built once per user and shared by every conversation that
 * user has (`server/src/main.ts:87,110-116`). A mutable `runtime.stackId` would be
 * correct for one turn at a time and racy for two: a second turn started while the
 * first is mid-flight would overwrite the field, and the first turn's tool calls
 * would then read a Stack its user never named. `AsyncLocalStorage` keeps the value
 * on the async chain instead, so concurrent turns cannot see each other's — the
 * concurrency test at the bottom of this file is that claim's evidence.
 */

interface RecordedCall {
  name: string;
  args: Record<string, unknown>;
}

interface RecordingClient {
  calls: RecordedCall[];
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: unknown[] }>;
}

function recorder(): RecordingClient {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async callTool(name, args) {
      calls.push({ name, args });
      return { content: [{ type: "text", text: "{}" }] };
    },
  };
}

/** A tool that reads one Stack: its schema declaring `stackId` is the tell. */
const SCOPED = {
  name: "ingest_jobs_list",
  description: "List this Stack's ingest jobs.",
  inputSchema: {
    type: "object",
    properties: { limit: { type: "integer" }, stackId: { type: "string" } },
  },
};

/** A tool that belongs to no Stack, so it must keep working with no context. */
const UNSCOPED = {
  name: "compile_wiki",
  description: "Compile the wiki.",
  inputSchema: { type: "object", properties: {} },
};

interface ToolResult {
  content: Array<{ text?: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

type ToolLike = {
  execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
};

/** What `proxyMcpTools` needs from a tool descriptor. */
interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

function mount(
  client: RecordingClient,
  descriptors: McpToolDescriptor[] = [SCOPED],
  log?: Logger,
): ToolLike[] {
  return proxyMcpTools("alice", client as never, descriptors, log).map(
    (tool) => tool as unknown as ToolLike,
  );
}

/** A `Logger` whose records the test can read, in the shape `log.test.ts` uses. */
function capturedLog(): { logger: Logger; lines: string[]; parsed: () => Array<Record<string, unknown>> } {
  const lines: string[] = [];
  const logger = new Logger({ level: "debug", sink: (line) => lines.push(line) });
  return {
    logger,
    lines,
    parsed: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** Every text block joined, which is what a reader of the result actually sees. */
function textOf(result: ToolResult): string {
  return result.content.map((block) => block.text ?? "").join("");
}

/**
 * The stored default is gone at the TYPE level, not merely unused.
 *
 * A regression that reintroduces `defaultStackId` on the http server would compile
 * and quietly restore the old injection source; this assertion turns that into a
 * type error instead. `never` is the tell: it is what the conditional yields when
 * the field exists again.
 */
type HttpServer = Extract<TenantMcpServer, { transport: "http" }>;
type StoredDefaultIsGone = HttpServer extends { defaultStackId?: unknown } ? never : true;
const storedDefaultIsGone: StoredDefaultIsGone = true;

test("the tenant's http server carries no stored Stack at all", () => {
  // Compile-time pin; the runtime half only proves the file was loaded.
  assert.equal(storedDefaultIsGone, true);
});

test("a Stack-scoped call the model left unscoped carries the request's Stack", async () => {
  const client = recorder();
  const [scoped] = mount(client);
  assert.ok(scoped, "the proxy must return the tool");

  const result = await withStackContext("stack-from-the-link", () =>
    scoped.execute("c1", { limit: 5 }),
  );

  assert.notEqual(result.isError, true);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0]?.args.stackId, "stack-from-the-link");
  // The rest of the call is untouched: this is an injection, not a rewrite.
  assert.equal(client.calls[0]?.args.limit, 5);
});

test("with no Stack context the call is blocked, visibly, and never reaches the upstream", async () => {
  const client = recorder();
  const [scoped] = mount(client);
  assert.ok(scoped);

  const result = await scoped.execute("c1", { limit: 5 });

  assert.equal(result.isError, true, "a call with no Stack must not look like a success");
  // S4: no argument and no turn Stack is the one case with no source at all, so the
  // message is asserted EXACTLY — it has to name what is missing AND how to fix it, and
  // a silently empty `stackId` must never be sent on its behalf.
  assert.equal(
    textOf(result),
    "ingest_jobs_list works on one Stack, and this turn has no Stack. " +
      "Open the app with a link that names it — ?user=<name>&stackId=<stack-id> — and ask again.",
  );
  assert.deepEqual(result.details, {});
  // The fact that matters: nothing went out unscoped. An error result plus an
  // upstream call would mean the data was read anyway and only the report lied.
  assert.equal(client.calls.length, 0, "the MCP client must receive ZERO calls");
});

test("a model argument equal to the request's Stack is accepted, with no error", async () => {
  // PRESERVE: the agreeing path is untouched by the override rule — same value, same
  // injected Stack, no error and no log record.

  const client = recorder();
  const [scoped] = mount(client);
  assert.ok(scoped);

  const result = await withStackContext("stack-from-the-link", () =>
    scoped.execute("c1", { stackId: "stack-from-the-link" }),
  );

  assert.notEqual(result.isError, true);
  assert.equal(client.calls[0]?.args.stackId, "stack-from-the-link");
});

test("an explicit tool argument wins over the turn's Stack (S1)", async () => {
  // The requirement, verbatim: "si el usuario indica que se use otro se usará, pero como
  // fallback siempre el de la URL". A differing argument is therefore a CHOICE, not the
  // contradiction the previous rule read it as, and the call goes out on it.
  const client = recorder();
  const [scoped] = mount(client);
  assert.ok(scoped);

  const result = await withStackContext("stack-from-the-link", () =>
    scoped.execute("c1", { stackId: "some-other-stack" }),
  );

  assert.notEqual(result.isError, true, "a differing argument is a choice, not an error");
  assert.equal(client.calls.length, 1, "the call must reach the upstream");
  assert.equal(
    client.calls[0]?.args.stackId,
    "some-other-stack",
    "the argument's Stack travels; the turn's Stack does not overwrite it",
  );
});

test("an explicit argument resolves even when the turn names no Stack at all", async () => {
  // The URL is the FALLBACK, not a precondition: with no link Stack but an explicit
  // argument, there is still exactly one Stack named, and it is the argument's.
  const client = recorder();
  const [scoped] = mount(client);
  assert.ok(scoped);

  const result = await scoped.execute("c1", { stackId: "some-other-stack" });

  assert.notEqual(result.isError, true);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0]?.args.stackId, "some-other-stack");
});

test("a non-string stackId is still refused as a type problem, with no upstream call", async () => {
  // Unchanged rule (S18/F3): an array is not a Stack name, so the sentence names the
  // type rather than pretending a Stack called 'A' was meant.
  const client = recorder();
  const [scoped] = mount(client);
  assert.ok(scoped);

  const result = await withStackContext("stack-from-the-link", () =>
    scoped.execute("c1", { stackId: ["A"] }),
  );

  assert.equal(result.isError, true);
  assert.equal(
    textOf(result),
    "ingest_jobs_list takes stackId as a string, and the call sent a array. " +
      "Call it again without stackId to use this turn's Stack.",
  );
  assert.equal(client.calls.length, 0, "a refused call must not read anything");
});

test("the override is not silent: one record names the turn's Stack and the argument's (D1)", async () => {
  const client = recorder();
  const log = capturedLog();
  const [scoped] = mount(client, [SCOPED], log.logger);
  assert.ok(scoped);

  const result = await withStackContext("stack-from-the-link", () =>
    scoped.execute("c1", { stackId: "some-other-stack" }),
  );

  assert.notEqual(result.isError, true);
  assert.equal(log.lines.length, 1, "exactly one record per overridden call");
  const [record] = log.parsed();
  assert.equal(record?.level, "info");
  assert.equal(record?.message, "tool call overrides the turn's Stack");
  assert.equal(record?.tool, "ingest_jobs_list");
  assert.equal(record?.turnStackId, "stack-from-the-link");
  assert.equal(record?.argumentStackId, "some-other-stack");
  assert.match(String(record?.time), /^\d{4}-\d{2}-\d{2}T/, "it is a record, not a sentence");
});

test("the non-override paths emit no such record", async () => {
  // Nothing diverged, so there is nothing to report: the fallback path, the agreeing
  // path and the refusal all stay quiet.
  const client = recorder();
  const log = capturedLog();
  const [scoped] = mount(client, [SCOPED], log.logger);
  assert.ok(scoped);

  await withStackContext("stack-from-the-link", () => scoped.execute("c1", { limit: 1 }));
  await withStackContext("stack-from-the-link", () => scoped.execute("c2", { stackId: "stack-from-the-link" }));
  await scoped.execute("c3", {});

  assert.deepEqual(log.lines, [], "no override happened, so nothing is logged");
});

test("a tool whose schema declares no stackId is called exactly as before", async () => {
  // The scope test is the schema, not the tenant: a tool that knows nothing about
  // Stacks must keep working with no context at all, or every non-Stack deployment
  // would break the moment the context is absent.
  const client = recorder();
  const [, unscoped] = mount(client, [SCOPED, UNSCOPED]);
  assert.ok(unscoped);

  const result = await unscoped.execute("c1", { question: "hola" });

  assert.notEqual(result.isError, true);
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0]?.args, { question: "hola" });
});

/**
 * A rendezvous: both callers must arrive before either continues, so the two
 * regions are provably suspended at the same time rather than run one after another.
 */
function rendezvous(): () => Promise<void> {
  let arrived = 0;
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived === 2) release();
    await gate;
  };
}

test("two concurrent turns in different Stacks never share a Stack (S12)", async () => {
  // ONE tool object, exactly as production has one runtime per user shared by all
  // of that user's conversations. If the Stack lived on the runtime, this test is
  // where it would bleed.
  const client = recorder();
  const [scoped] = mount(client);
  assert.ok(scoped);

  const meet = rendezvous();

  const turn = (stackId: string, tag: string) =>
    withStackContext(stackId, async () => {
      // Both regions are inside their own store when this resolves.
      await meet();
      const result = await scoped.execute(`c-${tag}`, { tag });
      return { tag, stackId, isError: result.isError === true };
    });

  const [a, b] = await Promise.all([turn("stack-a", "a"), turn("stack-b", "b")]);

  assert.deepEqual(a, { tag: "a", stackId: "stack-a", isError: false });
  assert.deepEqual(b, { tag: "b", stackId: "stack-b", isError: false });

  // Interleaved means each call arrived with ITS OWN Stack, in its own turn.
  const byTag = new Map(client.calls.map((call) => [call.args.tag, call.args.stackId]));
  assert.equal(byTag.get("a"), "stack-a");
  assert.equal(byTag.get("b"), "stack-b");

  // And nothing leaked out of the regions once they finished.
  assert.equal(currentStackId(), undefined);
});

test("the turn route runs the handler inside the request's Stack context", async () => {
  // The transport half of the rule: the SPA names the Stack on the turn POST, the
  // route reads it, trims it, and the whole background turn inherits it. The fake
  // TurnService reads the context at the earliest observable point.
  const seen: Array<string | undefined> = [];
  const turns = {
    async start() {
      seen.push(currentStackId());
      return { kind: "not_found" as const };
    },
  };

  const router = createRouter({ authenticate: createAuthenticator({ devToken: "tok" }) });
  registerRoutes(router, {
    store: {} as unknown as ConversationStore,
    turns: turns as unknown as TurnService,
  });

  const server: Server = await router.listen(0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const post = async (headers: Record<string, string>): Promise<number> => {
    const response = await fetch(`${baseUrl}/conversations/c1/turns`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dev-token": "tok",
        "x-user-id": "alice",
        "idempotency-key": `k-${seen.length}`,
        ...headers,
      },
      body: JSON.stringify({ message: "hola" }),
    });
    await response.text();
    return response.status;
  };

  try {
    // Trimmed, so a link copied with whitespace still names its Stack.
    assert.equal(await post({ "x-stack-id": "  stack-from-the-link  " }), 404);
    // Whitespace only is no Stack at all, not a Stack named "  ".
    assert.equal(await post({ "x-stack-id": "   " }), 404);
    // Absent is no Stack, and the route must not invent one.
    assert.equal(await post({}), 404);

    // PRESERVE: the handler was restructured to run inside the context, so its
    // existing refusal still has to hold — and still happens before anything starts.
    const refused = await fetch(`${baseUrl}/conversations/c1/turns`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dev-token": "tok", "x-user-id": "alice" },
      body: JSON.stringify({ message: "hola" }),
    });
    assert.equal(refused.status, 400);
    assert.equal(
      ((await refused.json()) as { error: string }).error,
      "idempotency_key_required",
    );
  } finally {
    server.close();
  }

  assert.deepEqual(seen, ["stack-from-the-link", undefined, undefined]);
});

test("the turn's Stack survives the handler, into the background work that runs later", async () => {
  // `turn-service.ts` starts the turn and does NOT await it: the frames are produced
  // after the handler already has them, and the tool calls happen inside that later
  // chain. If the context were tied to the request object rather than the async
  // chain, every real turn would lose its Stack exactly here.
  const seen: Array<string | undefined> = [];
  const turns = {
    async start() {
      async function* frames(): AsyncGenerator<{ type: "run_finished"; outcome: string }> {
        await new Promise((resolve) => setTimeout(resolve, 5));
        seen.push(currentStackId());
        yield { type: "run_finished", outcome: "ok" };
      }
      return { kind: "started" as const, runId: "r1", frames: frames() };
    },
  };

  const router = createRouter({ authenticate: createAuthenticator({ devToken: "tok" }) });
  registerRoutes(router, {
    store: {} as unknown as ConversationStore,
    turns: turns as unknown as TurnService,
  });

  const server: Server = await router.listen(0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const response = await fetch(`${baseUrl}/conversations/c1/turns`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dev-token": "tok",
        "x-user-id": "alice",
        "idempotency-key": "k-1",
        "x-stack-id": "stack-from-the-link",
      },
      body: JSON.stringify({ message: "hola" }),
    });
    await response.text();
  } finally {
    server.close();
  }

  assert.deepEqual(seen, ["stack-from-the-link"]);
});
