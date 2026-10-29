import { test } from "node:test";
import assert from "node:assert/strict";
import { proxyMcpTools } from "../src/pi/tenant-runtime.ts";

/**
 * The rule this file pins
 *
 * Every MCP read tool takes an OPTIONAL `stackId`, and omitting it inherits the
 * remote host's binding. That binding is not this product's to trust: on
 * 2026-10-28 it moved to an empty Stack and the agent reported "0 pages" — truthfully,
 * and about a Stack the user had never heard of — while their work sat elsewhere.
 *
 * So the proxy names a Stack itself. It does not, however, overrule a Stack the caller
 * asked for: that would be the same lie in the opposite direction.
 */

interface RecordingClient {
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: unknown[] }>;
  listTools(): Promise<unknown[]>;
}

function recorder(): RecordingClient {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    async callTool(name, args) {
      calls.push({ name, args });
      return { content: [{ type: "text", text: "{}" }] };
    },
    async listTools() {
      return [];
    },
  };
}

const TOOL = { name: "wiki_status", description: "status", inputSchema: { type: "object" } };

async function run(
  defaultStackId: string | undefined,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const client = recorder();
  const [tool] = proxyMcpTools("alice", client as never, [TOOL], defaultStackId);
  assert.ok(tool, "the proxy must return one tool");
  await (tool as unknown as {
    execute: (id: string, p: Record<string, unknown>) => Promise<unknown>;
  }).execute("call-1", params);
  const call = client.calls[0];
  assert.ok(call, "the tool must reach the client");
  return call.args;
}

test("names the configured Stack when the caller names none", async () => {
  const args = await run("b8b8e801-b423-4a32-ab0b-e1ea2d82ead8", {});
  assert.equal(args.stackId, "b8b8e801-b423-4a32-ab0b-e1ea2d82ead8");
});

test("does not overrule a Stack the caller named", async () => {
  // An explicit argument wins. Silently replacing it would be the same class of
  // defect as inheriting the host default: a caller (or the model) saying one thing
  // and the request carrying another.
  const args = await run("configured-stack", { stackId: "caller-stack" });
  assert.equal(args.stackId, "caller-stack");
});

test("sends nothing when neither the caller nor the config names a Stack", async () => {
  // Not an empty string: `?stackId=` would name a Stack called "".
  const args = await run(undefined, {});
  assert.equal("stackId" in args, false);
});

test("keeps every other argument intact while adding the Stack", async () => {
  const args = await run("s", { limit: 10, question: "hola" });
  assert.equal(args.limit, 10);
  assert.equal(args.question, "hola");
  assert.equal(args.stackId, "s");
});
