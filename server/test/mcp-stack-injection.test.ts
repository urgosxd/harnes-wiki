import { test } from "node:test";
import assert from "node:assert/strict";
import { proxyMcpTools } from "../src/pi/tenant-runtime.ts";
import { withStackContext } from "../src/pi/stack-context.ts";

/**
 * The rule this file pins
 *
 * Every MCP read tool takes an OPTIONAL `stackId`, and omitting it inherits the
 * remote host's binding. That binding is not this product's to trust: on
 * 2026-10-28 it moved to an empty Stack and the agent reported "0 pages" — truthfully,
 * and about a Stack the user had never heard of — while their work sat elsewhere.
 *
 * The replacement is the REQUEST's Stack, carried from the link into the tool call by
 * `stack-context.ts`. There is no stored default behind it any more: the tenant's
 * server row no longer carries one and `tenant_mcp.default_stack_id` is not read, so
 * with no context the call FAILS instead of going out unscoped.
 *
 * And an explicit argument wins over the link's Stack, which is the FALLBACK — the user's
 * requirement, verbatim: "si el usuario indica que se use otro se usará, pero como
 * fallback siempre el de la URL". So a different value is honoured, not refused and not
 * silently rewritten back to the link's, and the divergence is logged once instead of
 * being invisible (Manager decision D1).
 */

interface RecordingClient {
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: unknown[] }>;
}

function recorder(): RecordingClient {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    async callTool(name, args) {
      calls.push({ name, args });
      return { content: [{ type: "text", text: "{}" }] };
    },
  };
}

interface ToolResult {
  content: Array<{ text?: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

type ToolLike = {
  execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
};

/** A Stack-scoped tool: the schema declaring `stackId` is what marks it as one. */
const TOOL = {
  name: "wiki_status",
  description: "status",
  inputSchema: { type: "object", properties: { stackId: { type: "string" } } },
};

interface RunResult {
  result: ToolResult;
  args: Record<string, unknown> | undefined;
  calls: number;
}

async function run(context: string | undefined, params: Record<string, unknown>): Promise<RunResult> {
  const client = recorder();
  const [tool] = proxyMcpTools("alice", client as never, [TOOL]);
  assert.ok(tool, "the proxy must return one tool");
  const result = await withStackContext(context, () =>
    (tool as unknown as ToolLike).execute("call-1", params),
  );
  return { result, args: client.calls[0]?.args, calls: client.calls.length };
}

function textOf(result: ToolResult): string {
  return result.content.map((block) => block.text ?? "").join("");
}

test("names the request's Stack when the model names none", async () => {
  const { args, result } = await run("b8b8e801-b423-4a32-ab0b-e1ea2d82ead8", {});
  assert.notEqual(result.isError, true);
  assert.equal(args?.stackId, "b8b8e801-b423-4a32-ab0b-e1ea2d82ead8");
});

test("accepts a Stack the model named when it is the request's own", async () => {
  // The same value is not a conflict: the model agreeing with the link is fine.
  const { args, result } = await run("stack-a", { stackId: "stack-a" });
  assert.notEqual(result.isError, true);
  assert.equal(args?.stackId, "stack-a");
});

test("an argument naming a different Stack wins over the request's", async () => {
  // The requirement, verbatim: "si el usuario indica que se use otro se usará, pero como
  // fallback siempre el de la URL". The argument is the choice; the request's Stack is
  // only the fallback, so honouring it is the requested behaviour.
  const { args, result, calls } = await run("stack-a", { stackId: "stack-b" });
  assert.notEqual(result.isError, true);
  assert.equal(args?.stackId, "stack-b");
  assert.equal(calls, 1, "an honoured argument reaches the upstream exactly once");
});

test("with no Stack context the call is blocked and the stored default is never consulted", async () => {
  // There is no stored default left to consult — the tenant server row no longer
  // carries one and the column is not read — so this asserts the only remaining
  // honest outcome: refuse, visibly, instead of sending nothing and inheriting
  // whatever Stack the upstream happens to sit on.
  const { result, args, calls } = await run(undefined, {});
  assert.equal(result.isError, true);
  assert.match(textOf(result), /\?user=<name>&stackId=<stack-id>/);
  assert.equal(args, undefined);
  assert.equal(calls, 0, "the MCP client must receive ZERO calls");
});

test("keeps every other argument intact while adding the Stack", async () => {
  const { args, result } = await run("s", { limit: 10, question: "hola" });
  assert.notEqual(result.isError, true);
  assert.equal(args?.limit, 10);
  assert.equal(args?.question, "hola");
  assert.equal(args?.stackId, "s");
});
