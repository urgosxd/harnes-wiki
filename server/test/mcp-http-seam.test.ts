import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createDatabase, type Database } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { ConversationStore } from "../src/db/conversation-store.ts";
import { TenantRuntime } from "../src/pi/tenant-runtime.ts";
import { databaseReady } from "./support/harness.ts";
import { AGENT_DIR, hasCredentials, makeWorkspace } from "./support/env.ts";

/**
 * WHY THESE EXIST
 *
 * The MCP seam used to be stdio-only, which made an external MCP server
 * unreachable without shipping its binary into this image — the coupling this
 * project refuses. Adding an HTTP transport is only worth anything if three things
 * hold, and each is pinned below:
 *
 *  1. A row saying `http` connects over HTTP and never spawns a process.
 *  2. The transport's required headers reach the server, because some servers
 *     answer 406 without `Accept: application/json, text/event-stream`.
 *  3. A row saying `stdio` keeps behaving exactly as before.
 */

/** A stand-in MCP server over streamable HTTP, with the real protocol's edges. */
class FakeMcpHttpServer {
  server!: Server;
  port = 0;
  /** Every request the server saw, so a test can prove headers arrived. */
  readonly seen: Array<{ method: string; accept: string | undefined; auth: string | undefined }> = [];
  /** Tool names this server advertises. */
  /**
   * Tool descriptors this server advertises.
   *
   * `stackId` is part of the schema on purpose: contract `job-tools.ts@2` added it
   * so a caller names the Stack instead of inheriting one from the host process,
   * and a proxy that drops the schema makes that unreachable for the model.
   */
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> = [
    {
      name: "ingest_jobs_list",
      description: "List this Stack's recent async ingest jobs.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 200 },
          stackId: { type: "string" },
        },
      },
    },
    {
      name: "ingest_job_status",
      description: "Read one async ingest job by id.",
      inputSchema: { type: "object", properties: { jobId: { type: "string" }, stackId: { type: "string" } } },
    },
    { name: "compile_wiki", description: "Compile the wiki.", inputSchema: { type: "object", properties: {} } },
  ];
  /** When set, refuse every POST with 406 as a real server does without Accept. */
  requireAccept = true;
  /** Stack ids this server considers real, so the unknown-Stack guard is testable. */
  knownStacks = ["11111111-1111-1111-1111-111111111111"];

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const accept = req.headers.accept;
      this.seen.push({
        method: req.method ?? "GET",
        accept: typeof accept === "string" ? accept : undefined,
        auth: typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
      });

      // The transport answers 406 without the event-stream half of Accept. This is
      // the edge that makes a naive client fail, so the fake enforces it.
      if (this.requireAccept && !(accept ?? "").includes("text/event-stream")) {
        res.writeHead(406, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not acceptable" }));
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(405, { allow: "GET, POST" });
        res.end();
        return;
      }
      if (req.method === "GET") {
        // The server-to-client stream. Held open; the transport may or may not use it.
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(": open\n\n");
        return;
      }

      const body = Buffer.concat(chunks).toString("utf8");
      let rpc: { id?: unknown; method?: string; params?: unknown } = {};
      try {
        rpc = JSON.parse(body) as typeof rpc;
      } catch {
        this.sse(res, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }

      switch (rpc.method) {
        case "initialize":
          this.sse(res, {
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "fake-wiki", version: "0.0.1" },
            },
          });
          return;
        case "tools/list":
          this.sse(res, { jsonrpc: "2.0", id: rpc.id, result: { tools: this.tools } });
          return;
        case "tools/call": {
          const params = (rpc.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
          const stackId = params.arguments?.stackId;
          // Mirror the real guard: an id this server does not know is an ERROR, not
          // an empty listing. Without this distinction a caller cannot tell "no
          // jobs" from "no such Stack", and a picker would render a fiction.
          if (typeof stackId === "string" && !this.knownStacks.includes(stackId)) {
            this.sse(res, {
              jsonrpc: "2.0",
              id: rpc.id,
              result: {
                content: [{ type: "text", text: `No Stack '${stackId}' exists.` }],
                isError: true,
              },
            });
            return;
          }
          this.sse(res, {
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              content: [{ type: "text", text: JSON.stringify({ called: params.name, args: params.arguments }) }],
            },
          });
          return;
        }
        default:
          this.sse(res, {
            jsonrpc: "2.0",
            id: rpc.id,
            error: { code: -32601, message: `no method ${rpc.method}` },
          });
      }
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  /**
   * SSE-framed reply, which is what the real mount sends: a line `event: message`
   * and then `data: {json}`. A client that parses the whole body as JSON breaks
   * here, and this fake would let it pass if it replied with bare JSON.
   */
  private sse(res: ServerResponse, payload: unknown): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

describe("the tenant MCP seam can speak streamable HTTP", () => {
  const fake = new FakeMcpHttpServer();

  before(async () => {
    await fake.start();
  });

  after(async () => {
    await fake.close();
  });

  const skip = hasCredentials() ? false : "no Pi credentials on this machine";

  test("an http row connects over the network and proxies its tools", { skip }, async () => {
    const runtime = await TenantRuntime.create({
      tenant: {
        id: "http-tenant",
        mcpServers: [
          {
            transport: "http",
            name: "wiki",
            url: fake.url,
            // The real mount refuses a POST without this header, so the row has to
            // be able to carry it. Injecting it from code would put one
            // deployment's requirement into every deployment's build.
            headers: { accept: "application/json, text/event-stream" },
          },
        ],
        exposedMcpTools: ["ingest_job_status", "ingest_jobs_list"],
        scopes: [],
      },
      agentDir: AGENT_DIR,
      workspaceDir: makeWorkspace(),
      systemPrompt: "You are concise.",
    });

    try {
      const names = runtime.customTools.map(
        (tool) => (tool as unknown as { name?: string }).name ?? "",
      );
      assert.ok(names.includes("ingest_job_status"), "the tool must be proxied");
      assert.ok(names.includes("ingest_jobs_list"), "the tool must be proxied");
      // Only the requested ones: a server advertising more must not leak them in.
      assert.ok(!names.includes("compile_wiki"), "unrequested tools must not be mounted");

      // The header travelled, which is the whole reason the row carries headers.
      const posts = fake.seen.filter((entry) => entry.method === "POST");
      assert.ok(posts.length > 0, "the client must have POSTed to the endpoint");
      assert.ok(
        posts.every((entry) => (entry.accept ?? "").includes("text/event-stream")),
        "every POST must carry the Accept the server demands",
      );
    } finally {
      await runtime.close();
    }
  });

  /**
   * Contract `src/mcp/job-tools.ts@2`: the model names the Stack.
   *
   * These three tests are the client half of that agreement. The server half — that
   * an unknown id is an error rather than an empty list — is its own guard; what
   * can break HERE is the proxy dropping the schema or swallowing `isError`, and
   * either failure makes the model's argument unreachable while everything still
   * looks connected.
   */
  test("the proxied schema declares stackId, so the model can see it", { skip }, async () => {
    const runtime = await TenantRuntime.create({
      tenant: {
        id: "schema-tenant",
        mcpServers: [
          {
            transport: "http",
            name: "wiki",
            url: fake.url,
            headers: { accept: "application/json, text/event-stream" },
          },
        ],
        exposedMcpTools: ["ingest_jobs_list"],
        scopes: [],
      },
      agentDir: AGENT_DIR,
      workspaceDir: makeWorkspace(),
      systemPrompt: "You are concise.",
    });

    try {
      const tool = runtime.customTools[0] as unknown as { parameters: Record<string, unknown> };
      const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
      assert.ok("stackId" in properties, "a dropped schema makes stackId unreachable for the model");
      assert.ok("limit" in properties);
      // The server's own description travels too: it is the only text that knows
      // what the tool does.
      const described = runtime.customTools[0] as unknown as { description?: string };
      assert.match(described.description ?? "", /ingest jobs/i);
    } finally {
      await runtime.close();
    }
  });

  test("stackId reaches the server, and an unknown one stays an error", { skip }, async () => {
    const runtime = await TenantRuntime.create({
      tenant: {
        id: "stack-arg",
        mcpServers: [
          {
            transport: "http",
            name: "wiki",
            url: fake.url,
            headers: { accept: "application/json, text/event-stream" },
          },
        ],
        exposedMcpTools: ["ingest_jobs_list"],
        scopes: [],
      },
      agentDir: AGENT_DIR,
      workspaceDir: makeWorkspace(),
      systemPrompt: "You are concise.",
    });

    try {
      const tool = runtime.customTools[0] as unknown as {
        execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }>;
      };

      // A known Stack: the argument must arrive intact.
      const known = await tool.execute(
        "c1",
        { stackId: "11111111-1111-1111-1111-111111111111" },
        undefined,
        undefined,
        undefined,
      );
      assert.match(
        known.content.map((b) => b.text ?? "").join(""),
        /11111111-1111-1111-1111-111111111111/,
        "the stackId must reach the server, not be dropped by the proxy",
      );
      assert.ok(!known.isError);

      // An unknown Stack: an error, NOT an empty listing. If the proxy swallowed
      // isError, a picker would show a non-existent Stack as a valid empty one.
      const unknown = await tool.execute(
        "c2",
        { stackId: "00000000-0000-0000-0000-000000000000" },
        undefined,
        undefined,
        undefined,
      );
      assert.equal(unknown.isError, true, "isError must survive the proxy");
      assert.match(unknown.content.map((b) => b.text ?? "").join(""), /No Stack/);
    } finally {
      await runtime.close();
    }
  });

  test("omitting stackId still works: the contract is backward compatible", { skip }, async () => {
    const runtime = await TenantRuntime.create({
      tenant: {
        id: "no-stack",
        mcpServers: [
          {
            transport: "http",
            name: "wiki",
            url: fake.url,
            headers: { accept: "application/json, text/event-stream" },
          },
        ],
        exposedMcpTools: ["ingest_jobs_list"],
        scopes: [],
      },
      agentDir: AGENT_DIR,
      workspaceDir: makeWorkspace(),
      systemPrompt: "You are concise.",
    });

    try {
      const tool = runtime.customTools[0] as unknown as {
        execute: (...args: unknown[]) => Promise<{ isError?: boolean }>;
      };
      const result = await tool.execute("c1", {}, undefined, undefined, undefined);
      assert.ok(!result.isError, "a call with no stackId must behave exactly as before");
    } finally {
      await runtime.close();
    }
  });

  test("proxied http tools actually reach the server", { skip }, async () => {
    const runtime = await TenantRuntime.create({
      tenant: {
        id: "http-call",
        mcpServers: [
          {
            transport: "http",
            name: "wiki",
            url: fake.url,
            headers: { accept: "application/json, text/event-stream" },
          },
        ],
        exposedMcpTools: ["ingest_jobs_list"],
        scopes: [],
      },
      agentDir: AGENT_DIR,
      workspaceDir: makeWorkspace(),
      systemPrompt: "You are concise.",
    });

    try {
      const tool = runtime.customTools[0] as unknown as {
        execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }>;
      };
      const result = await tool.execute("call-1", { limit: 5 }, undefined, undefined, undefined);
      const text = result.content.map((block) => block.text ?? "").join("");
      assert.match(text, /ingest_jobs_list/, "the call must have reached the fake server");
    } finally {
      await runtime.close();
    }
  });
});

describe("tenant_mcp rows are constrained to a connectable shape", () => {
  const canRun = databaseReady();
  const skip = canRun ? false : "needs Postgres";

  let db: Database;

  before(async () => {
    if (!canRun) return;
    db = createDatabase(
      process.env.DATABASE_URL ?? "postgres://agentdocumentor:agentdocumentor@127.0.0.1:5432/agentdocumentor",
    );
    await migrate(db);
  });

  after(async () => {
    await db?.close();
  });

  test("an http row without a url is refused by the database", { skip }, async () => {
    await assert.rejects(
      () =>
        db.query(
          `INSERT INTO tenant_mcp (user_id, server_name, command, transport, url)
           VALUES ('t-constraint', 'no-url', '', 'http', NULL)`,
        ),
      /tenant_mcp_transport_target/,
    );
  });

  test("a stdio row without a command is refused too", { skip }, async () => {
    await assert.rejects(
      () =>
        db.query(
          `INSERT INTO tenant_mcp (user_id, server_name, command, transport, url)
           VALUES ('t-constraint', 'no-command', '  ', 'stdio', NULL)`,
        ),
      /tenant_mcp_transport_target/,
    );
  });

  test("an existing stdio row keeps working: the transport defaults to stdio", { skip }, async () => {
    await db.query(`DELETE FROM tenant_mcp WHERE user_id = 't-default'`);
    await db.query(
      `INSERT INTO tenant_mcp (user_id, server_name, command, exposed_tools)
       VALUES ('t-default', 'legacy', 'node', '["mem_search"]'::jsonb)`,
    );
    const store = new ConversationStore(db);
    const servers = await store.listMcpServers("t-default");
    assert.equal(servers.length, 1);
    assert.equal(servers[0]?.transport, "stdio", "a row written before the migration is stdio");
    assert.equal(servers[0]?.command, "node");
    assert.equal(servers[0]?.url, null);
    await db.query(`DELETE FROM tenant_mcp WHERE user_id = 't-default'`);
  });

  test("an http row is read back with its url and headers", { skip }, async () => {
    await db.query(`DELETE FROM tenant_mcp WHERE user_id = 't-http'`);
    await db.query(
      `INSERT INTO tenant_mcp (user_id, server_name, command, transport, url, headers, exposed_tools)
       VALUES ('t-http', 'wiki', '', 'http', 'http://host:4173/mcp',
               '{"accept":"application/json, text/event-stream"}'::jsonb, '["ingest_jobs_list"]'::jsonb)`,
    );
    const store = new ConversationStore(db);
    const servers = await store.listMcpServers("t-http");
    assert.equal(servers[0]?.transport, "http");
    assert.equal(servers[0]?.url, "http://host:4173/mcp");
    assert.equal(servers[0]?.headers.accept, "application/json, text/event-stream");
    assert.equal(servers[0]?.command, "");
    await db.query(`DELETE FROM tenant_mcp WHERE user_id = 't-http'`);
  });
});
