import { test } from "node:test";
import assert from "node:assert/strict";
import { proxyMcpTools } from "../src/pi/tenant-runtime.ts";
import { withStackContext } from "../src/pi/stack-context.ts";
import { stackNoticeFromResult } from "../src/pi/session-factory.ts";
import { toolFinishedFrame } from "../src/api/turn-service.ts";
import { toolLabel } from "../src/pi/activity.ts";
import { Logger } from "../src/log.ts";

/**
 * The Stack a call actually ran on must be VISIBLE to the person using the product.
 *
 * A log line is not that: the reviewer's objection, accepted by the requester, was that
 * the log replaced the old refusal with something nobody reads — the refusal at least
 * told a human "a foreign Stack was used here". Forwarding an explicit argument is still
 * right (S1 of `urlparam-stackId.md`), so the divergence has to be shown where the human
 * is looking instead: in the turn's own output.
 *
 * Two halves, because they fail independently:
 *
 *  1. the tool result carries the notice as STRUCTURED DETAILS, never as content, so the
 *     model's context stays exactly what it was;
 *  2. the turn pipeline lifts that detail out of the finished call, which is what lets
 *     the client paint it (see `stackNoticeFromResult` below).
 *
 * The wording is asserted verbatim: a notice nobody can read is the same failure as a
 * log line nobody reads.
 */

interface Call {
  name: string;
  args: Record<string, unknown>;
}

interface Client {
  calls: Call[];
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: unknown[] }>;
}

function recorder(): Client {
  const calls: Call[] = [];
  return {
    calls,
    async callTool(name, args) {
      calls.push({ name, args });
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
}

/** A tool that reads one Stack: the published `stackId` property is the tell. */
const SCOPED = {
  name: "ingest_jobs_list",
  description: "List this Stack's ingest jobs.",
  inputSchema: {
    type: "object",
    properties: { limit: { type: "integer" }, stackId: { type: "string" } },
  },
};

interface ToolResult {
  content: Array<{ text?: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

type ToolLike = {
  execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
};

function mount(log?: Logger): ToolLike {
  const client = recorder();
  const [tool] = proxyMcpTools("alice", client as never, [SCOPED], log);
  assert.ok(tool, "the proxy must return the tool");
  return tool as unknown as ToolLike;
}

function textOf(result: ToolResult): string {
  return result.content.map((block) => block.text ?? "").join("");
}

function capturedLog(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: new Logger({ level: "debug", sink: (line) => lines.push(line) }), lines };
}

test("a call that runs on another Stack shows it, naming both Stacks", async () => {
  const tool = mount();
  const result = await withStackContext("stack-a", () => tool.execute("c1", { stackId: "stack-b" }));

  assert.notEqual(result.isError, true);
  assert.equal(
    result.details.stackNotice,
    "Ran on Stack stack-b, not the session's Stack stack-a.",
    "the person must be able to read which Stack was used, and which one was expected",
  );
});

test("with no session Stack, the notice says so instead of claiming one", async () => {
  // The turn's link named no Stack and the argument did (S1's fallback order), so there
  // is no "session Stack" to name. Saying one existed would be a false statement about
  // the request that produced the call.
  const tool = mount();
  const result = await tool.execute("c1", { stackId: "stack-b" });

  assert.notEqual(result.isError, true);
  assert.equal(result.details.stackNotice, "Ran on Stack stack-b; the session had no Stack.");
});

test("a call on the session's own Stack carries no notice", async () => {
  const tool = mount();
  const same = await withStackContext("stack-a", () => tool.execute("c1", { stackId: "stack-a" }));
  const fallback = await withStackContext("stack-a", () => tool.execute("c2", {}));

  assert.equal(same.details.stackNotice, undefined, "agreeing is not a divergence");
  assert.equal(fallback.details.stackNotice, undefined, "the fallback is the session's Stack");
});

test("the notice is details, not content: what the model reads is unchanged", async () => {
  // The model asked for a Stack and got it. Rewriting its tool result would put this
  // product's bookkeeping in front of the model's own answer.
  const tool = mount();
  const result = await withStackContext("stack-a", () => tool.execute("c1", { stackId: "stack-b" }));
  assert.equal(textOf(result), "ok");
});

test("the structured log record is kept alongside the visible notice", async () => {
  const log = capturedLog();
  const tool = mount(log.logger);
  const result = await withStackContext("stack-a", () => tool.execute("c1", { stackId: "stack-b" }));

  assert.equal(String(result.details.stackNotice).length > 0, true);
  assert.equal(log.lines.length, 1, "one record per overridden call, as before");
  assert.equal(JSON.parse(log.lines[0] ?? "{}").message, "tool call overrides the turn's Stack");
});

test("the notice rides the finished-call frame without touching its label", () => {
  // The client closes the running activity row by MATCHING the label it got from
  // `tool_started`, so a remark appended to the label would leave the row spinning and
  // the notice still unread. One field of its own, same label.
  const notice = "Ran on Stack stack-b, not the session's Stack stack-a.";
  assert.deepEqual(toolFinishedFrame("ingest_jobs_list", false, notice), {
    type: "tool_finished",
    tool: "ingest_jobs_list",
    label: toolLabel("ingest_jobs_list"),
    isError: false,
    notice,
  });
});

test("a call with nothing to say carries no notice field at all", () => {
  const frame = toolFinishedFrame("ingest_jobs_list", false);
  assert.equal("notice" in frame, false, "absent, not empty: there is no notice to show");
});

/**
 * The lift, on its own.
 *
 * `runTurn` cannot run without a model, so the seam that carries the notice out of a
 * finished tool call is a pure function and is tested directly: a detail that is not a
 * non-empty string is not a notice, and a result with no details is not a crash.
 */
test("the turn pipeline lifts a notice out of a finished call", () => {
  assert.equal(
    stackNoticeFromResult({ details: { stackNotice: "Ran on Stack b, not the session's Stack a." } }),
    "Ran on Stack b, not the session's Stack a.",
  );
});

test("anything that is not a non-empty notice string is no notice", () => {
  const cases: unknown[] = [
    undefined,
    null,
    {},
    { details: undefined },
    { details: null },
    { details: {} },
    { details: { stackNotice: 42 } },
    { details: { stackNotice: "" } },
    { details: { stackNotice: "   " } },
    { details: { stackNotice: null } },
  ];
  for (const value of cases) {
    assert.equal(
      stackNoticeFromResult(value),
      undefined,
      `${JSON.stringify(value)} must not be read as a notice`,
    );
  }
});
