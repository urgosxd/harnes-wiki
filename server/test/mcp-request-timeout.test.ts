import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, ConfigError } from "../src/config.ts";
import { TenantRuntime } from "../src/pi/tenant-runtime.ts";
import { runToolCall } from "@earendil-works/pi-agent-core";
import { AGENT_DIR, hasCredentials, makeWorkspace } from "./support/env.ts";

/**
 * WHY THESE EXIST
 *
 * The MCP client library kills every request at 30 s (`client.js:3`,
 * `DEFAULT_REQUEST_TIMEOUT_MS`), and our proxy called `client.callTool(name, args)` with
 * no options at all, so every tool inherited that number. Measured consequence: `query_wiki`
 * timed out at 30 s on a large Stack, and the number that did it appeared nowhere an
 * operator could read it.
 *
 * The fix is a deadline of our own, configurable, 120 s by default. Four things have to
 * hold, and a config test alone would prove none of them:
 *
 *  1. the default and the variable are read, and an invalid value fails the boot instead
 *     of silently becoming the default;
 *  2. the boot log reports the EFFECTIVE value;
 *  3. the number actually reaches `callTool` — a slow tool times out at the configured
 *     deadline, and the same tool succeeds when the deadline is longer. Without this pair
 *     the config would be decorative;
 *  4. the timeout arrives as a TOOL error the model can see, not as a dead turn.
 *
 * (3) and (4) run against a stand-in streamable-HTTP MCP server, the same seam the suite
 * already uses for the HTTP transport, and are skipped when this machine has no Pi
 * credentials — a runtime cannot be built without them. A skip is reported, never counted
 * as a pass.
 */

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const baseEnv = {
  PI_AGENT_DIR: "/pi/agent",
  PI_WORKSPACE_DIR: "/var/lib/chat/workspace",
  CHAT_PROVIDER: "synthetic",
  CHAT_MODEL: "syn:large:text",
} satisfies NodeJS.ProcessEnv;

// ---------------------------------------------------------------------------
// S1/S3: the configuration value itself
// ---------------------------------------------------------------------------

test("the MCP request timeout defaults to the 120 s the requester chose", () => {
  // The number is the requester's, not the library's: 30_000 here would mean the proxy
  // still inherits the default that broke query_wiki.
  assert.equal(loadConfig({ ...baseEnv }).mcpRequestTimeoutMs, 120_000);
});

test("MCP_REQUEST_TIMEOUT_MS sets the deadline, trimmed", () => {
  assert.equal(loadConfig({ ...baseEnv, MCP_REQUEST_TIMEOUT_MS: "45000" }).mcpRequestTimeoutMs, 45_000);
  assert.equal(loadConfig({ ...baseEnv, MCP_REQUEST_TIMEOUT_MS: "  45000  " }).mcpRequestTimeoutMs, 45_000);
});

test("an empty MCP_REQUEST_TIMEOUT_MS means 'unset', so the default applies", () => {
  // Every other optional value in config.ts reads this way; a blank line in an env file
  // must not be a boot failure.
  assert.equal(loadConfig({ ...baseEnv, MCP_REQUEST_TIMEOUT_MS: "" }).mcpRequestTimeoutMs, 120_000);
  assert.equal(loadConfig({ ...baseEnv, MCP_REQUEST_TIMEOUT_MS: "   " }).mcpRequestTimeoutMs, 120_000);
});

test("an invalid MCP_REQUEST_TIMEOUT_MS is refused, never silently defaulted", () => {
  // The decision this feature took: fail the boot. Falling back would leave an operator
  // believing they configured 300 s while getting 120 s — the same class of invisible
  // default that this feature removes.
  for (const value of ["abc", "30s", "0", "-1", "NaN", "Infinity"]) {
    assert.throws(
      () => loadConfig({ ...baseEnv, MCP_REQUEST_TIMEOUT_MS: value }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError, `${value}: must be a ConfigError`);
        assert.match(error.message, /MCP_REQUEST_TIMEOUT_MS must be a positive number/);
        assert.ok(
          error.message.includes(`"${value}"`),
          `${value}: the message must quote the offending value, got "${error.message}"`,
        );
        return true;
      },
    );
  }
});

// ---------------------------------------------------------------------------
// S3/S4: what an operator sees, measured by booting the real entry point
// ---------------------------------------------------------------------------

interface BootResult {
  status: number | null;
  /** The structured log lines the process wrote, in order. */
  lines: Array<Record<string, unknown>>;
  raw: string;
}

/**
 * Start `src/main.ts` far enough to report configuration and then stop.
 *
 * `DATABASE_URL` is deliberately absent: the boot fails at that check, which is AFTER the
 * timeout is reported, so the whole run is a real startup that touches nothing — no
 * container, no Postgres, no model. Every structured line the process wrote is returned.
 */
function boot(extra: Record<string, string> = {}): BootResult {
  const workspace = mkdtempSync(join(tmpdir(), "agentdoc-mcp-timeout-"));
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "src/main.ts"], {
    cwd: SERVER_ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? tmpdir(),
      PI_WORKSPACE_DIR: workspace,
      // Generate mode keeps the boot from demanding a real agent directory before the
      // check that stops it; nothing is written, because the boot fails first.
      PI_AGENT_CONFIG_MODE: "generate",
      CHAT_PROVIDER: "synthetic",
      CHAT_MODEL: "syn:large:text",
      ...extra,
    },
  });
  const raw = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const lines = raw
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
  return { status: result.status, lines, raw };
}

test("the boot log reports the default MCP request timeout once", () => {
  const booted = boot();
  const reported = booted.lines.filter((line) => line.message === "mcp request timeout");
  assert.equal(reported.length, 1, "the effective timeout must be on the record exactly once");
  assert.equal(reported[0]?.level, "info");
  assert.equal(reported[0]?.timeoutMs, 120_000, "the default is what an operator reads here");
});

test("the boot log reports the configured MCP request timeout, not the default", () => {
  const booted = boot({ MCP_REQUEST_TIMEOUT_MS: "45000" });
  const reported = booted.lines.filter((line) => line.message === "mcp request timeout");
  assert.equal(reported.length, 1);
  assert.equal(reported[0]?.timeoutMs, 45_000);
});

test("an invalid value fails the boot with a fatal line naming it, and no timeout is reported", () => {
  const booted = boot({ MCP_REQUEST_TIMEOUT_MS: "abc" });
  assert.equal(booted.status, 1, "a refused configuration must not start a server");
  // Nothing resolved a timeout, so nothing may claim one: no fallback happened.
  assert.equal(
    booted.lines.filter((line) => line.message === "mcp request timeout").length,
    0,
    "an invalid value must not be reported as an effective one",
  );
  const fatal = booted.lines.find((line) => line.level === "error" && line.message === "fatal");
  assert.ok(fatal, `the exit must be reported as fatal, got: ${booted.raw}`);
  assert.match(String(fatal.error), /MCP_REQUEST_TIMEOUT_MS must be a positive number, got "abc"/);
});

// ---------------------------------------------------------------------------
// S2/S5: the number reaches callTool, through a real MCP client
// ---------------------------------------------------------------------------

/**
 * A stand-in streamable-HTTP MCP server whose `tools/call` is slow on demand.
 *
 * Same protocol edges as the one the HTTP seam test uses (SSE-framed replies), minus
 * everything this file does not exercise: one tool, one behaviour, and a configurable
 * delay that is the whole point — a deadline can only be observed against a call that
 * outlives it.
 */
class SlowMcpServer {
  server!: Server;
  port = 0;
  /** How long every `tools/call` waits before answering. */
  delayMs = 0;
  readonly calls: string[] = [];
  readonly tools = [
    {
      name: "query_wiki",
      description: "Answer a question from this Stack's wiki.",
      inputSchema: { type: "object", properties: { question: { type: "string" }, stackId: { type: "string" } } },
    },
  ];

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);

      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(": open\n\n");
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }

      let rpc: { id?: unknown; method?: string; params?: unknown };
      try {
        rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof rpc;
      } catch {
        this.reply(res, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }

      switch (rpc.method) {
        case "initialize":
          this.reply(res, {
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
          this.reply(res, { jsonrpc: "2.0", id: rpc.id, result: { tools: this.tools } });
          return;
        case "tools/call": {
          const params = (rpc.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
          this.calls.push(params.name ?? "");
          await new Promise((resolve) => setTimeout(resolve, this.delayMs));
          this.reply(res, {
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              content: [{ type: "text", text: JSON.stringify({ called: params.name, args: params.arguments }) }],
            },
          });
          return;
        }
        default:
          // Notifications (`notifications/cancelled` after a timeout, and anything else
          // without an id) are acknowledged and answered with nothing.
          if (rpc.id === undefined) {
            if (!res.writableEnded && !res.destroyed) res.writeHead(202).end();
            return;
          }
          this.reply(res, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: `no method ${rpc.method}` } });
      }
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  /** SSE framing, which is what a real mount sends — bare JSON would let a bad client pass. */
  private reply(res: ServerResponse, payload: unknown): void {
    // A client that already timed out has dropped this response, and writing to the
    // closed socket would throw inside the server instead of failing the test.
    if (res.writableEnded || res.destroyed) return;
    try {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch {
      // The socket died while the response was being written; the client is gone.
    }
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const credentialsReady = hasCredentials();
const skip = credentialsReady ? false : "no Pi credentials on this machine";

describe("the configured timeout reaches the MCP client", () => {
  const fake = new SlowMcpServer();

  before(async () => {
    await fake.start();
  });

  after(async () => {
    await fake.close();
  });

  /** Build a tenant runtime pointed at the slow server, with (or without) an explicit deadline. */
  async function runtimeWith(timeoutMs: number | undefined): Promise<TenantRuntime> {
    return TenantRuntime.create({
      tenant: {
        id: "timeout-tenant",
        mcpServers: [
          {
            transport: "http",
            name: "wiki",
            url: fake.url,
            headers: { accept: "application/json, text/event-stream" },
          },
        ],
        exposedMcpTools: ["query_wiki"],
        scopes: [],
      },
      agentDir: AGENT_DIR,
      workspaceDir: makeWorkspace(),
      systemPrompt: "You are concise.",
      ...(timeoutMs === undefined ? {} : { mcpRequestTimeoutMs: timeoutMs }),
    });
  }

  /** Run the proxied tool the way the agent loop does, so the model's result is what we assert. */
  async function modelCalls(
    runtime: TenantRuntime,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; text: string }> {
    const tools = runtime.customTools as unknown as never[];
    const outcome = await runToolCall(
      { type: "toolCall", id: "call-1", name: "query_wiki", arguments: args } as never,
      {
        tools: tools as never,
        assistantMessage: { role: "assistant", content: [] } as never,
        context: { messages: [], tools: tools as never } as never,
      },
    );
    const text = (outcome.result.content as Array<{ type?: string; text?: string }>)
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    return { isError: outcome.isError, text };
  }

  test("the runtime reports the configured deadline as the effective one", { skip }, async () => {
    // The seam the number travels through, made reportable so a wiring regression fails
    // here instead of waiting 30 s in production.
    const configured = await runtimeWith(45_000);
    try {
      assert.equal(configured.mcpRequestTimeoutMs, 45_000);
    } finally {
      await configured.close();
    }
  });

  test("with no explicit deadline the runtime uses 120 s, never the library's 30 s", { skip }, async () => {
    const bare = await runtimeWith(undefined);
    try {
      assert.equal(bare.mcpRequestTimeoutMs, 120_000);
    } finally {
      await bare.close();
    }
  });

  test(
    "a slow tool times out AT the configured deadline and the model sees a tool error",
    { skip },
    async () => {
      fake.delayMs = 1_500;
      const runtime = await runtimeWith(250);
      try {
        const result = await modelCalls(runtime, { question: "how big is the wiki", stackId: "stack-a" });
        // S5: a tool error, not a dead turn. This is the outcome the turn ends up with, so
        // the model can narrow the query or tell the user instead of the run collapsing.
        assert.equal(result.isError, true, "a timed-out tool must be reported as a tool error");
        // The message carries the deadline the client actually used, which is the only
        // proof that the number reached `callTool` rather than sitting in config.
        assert.match(result.text, /MCP request timed out after 250ms/);
      } finally {
        await runtime.close();
      }
    },
  );

  test(
    "the same slow tool succeeds when the deadline is longer, so the pair proves the wiring",
    { skip },
    async () => {
      fake.delayMs = 1_500;
      const runtime = await runtimeWith(10_000);
      try {
        const result = await modelCalls(runtime, { question: "how big is the wiki", stackId: "stack-a" });
        assert.equal(result.isError, false, `the call must not time out at 10 s: ${result.text}`);
        assert.match(result.text, /query_wiki/, "the upstream's answer must come back intact");
      } finally {
        await runtime.close();
      }
    },
  );
});
