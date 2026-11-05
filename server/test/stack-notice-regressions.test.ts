import { test } from "node:test";
import assert from "node:assert/strict";
import { proxyMcpTools } from "../src/pi/tenant-runtime.ts";
import { withStackContext } from "../src/pi/stack-context.ts";
import { stackNoticeFromResult } from "../src/pi/session-factory.ts";
import { toolFinishedFrame } from "../src/api/turn-service.ts";
import { toolLabel } from "../src/pi/activity.ts";
import { Logger } from "../src/log.ts";

/**
 * The visible Stack notice, probed independently of the implementation's own tests.
 *
 * Adapted from the read-only verification pass over `01180f1`/`ecaa446` (kept as a
 * durable artifact for the same reason `stack-scope-gate.test.ts` was): each case here
 * asserts an OBSERVABLE fact of the chain a person's screen depends on — the sentence
 * that reaches the tool result's details, the log record beside it, the frame field that
 * carries it, and the refusal paths that must produce no notice at all.
 *
 * Two rules are deliberately not restated as prose here and are pinned as behaviour:
 * a divergence is never silent, and a sentence never names a session Stack that did not
 * exist. Wording is asserted verbatim, because a sentence nobody can read is the same
 * failure as a log line nobody reads.
 *
 * Public surface only: `proxyMcpTools`, the request context, the detail lift and the
 * frame writer. The fake client COUNTS calls, because "returned an error" and "never
 * reached the upstream" are different facts.
 */

interface Call {
  name: string;
  args: Record<string, unknown>;
}

const calls: Call[] = [];
const client = {
  async callTool(name: string, args: Record<string, unknown>) {
    calls.push({ name, args });
    return { content: [{ type: "text", text: "UPSTREAM" }] };
  },
};

interface Descriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A tool that publishes `stackId` the way contract `job-tools.ts@2` does. */
const scoped = (name: string): Descriptor => ({
  name,
  description: name,
  inputSchema: {
    type: "object",
    properties: { limit: { type: "integer" }, stackId: { type: "string" } },
  },
});

/** A tool whose schema publishes no Stack at all: it is called exactly as before. */
const plain = (name: string): Descriptor => ({
  name,
  description: name,
  inputSchema: { type: "object", properties: {} },
});

interface Result {
  content: Array<{ text?: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

type Mounted = {
  execute: (id: string, params: Record<string, unknown>) => Promise<Result>;
};

function mount(descriptors: Descriptor[], log?: Logger): Map<string, Mounted> {
  const tools = proxyMcpTools("probe", client as never, descriptors, log);
  return new Map(
    tools.map((tool) => {
      const mounted = tool as unknown as Mounted & { name: string };
      return [mounted.name, mounted] as const;
    }),
  );
}

function tool(name: string): Mounted {
  const mounted = mount([scoped(name)]).get(name);
  assert.ok(mounted, `${name} must be mounted`);
  return mounted;
}

function text(result: Result): string {
  return result.content.map((block) => block.text ?? "").join("");
}

function logLines(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: new Logger({ level: "debug", sink: (line) => lines.push(line) }), lines };
}

test("a divergent call names the tool and both Stacks, and forwards the argument", async () => {
  const target = tool("ingest_jobs_list");
  const before = calls.length;
  const result = await withStackContext("stack-a", () => target.execute("c", { stackId: "stack-b" }));

  assert.equal(
    result.details.stackNotice,
    "ingest_jobs_list was sent to Stack stack-b, not the session's Stack stack-a.",
  );
  assert.deepEqual(calls[before]?.args, { stackId: "stack-b" }, "the argument is the one used");
  assert.equal(text(result), "UPSTREAM", "the model's tool result is unchanged");
  assert.equal(
    stackNoticeFromResult(result),
    "ingest_jobs_list was sent to Stack stack-b, not the session's Stack stack-a.",
    "the turn pipeline can lift it out of the finished call",
  );
  assert.deepEqual(
    toolFinishedFrame("ingest_jobs_list", false, stackNoticeFromResult(result)),
    {
      type: "tool_finished",
      tool: "ingest_jobs_list",
      label: toolLabel("ingest_jobs_list"),
      isError: false,
      notice: "ingest_jobs_list was sent to Stack stack-b, not the session's Stack stack-a.",
    },
    "and the frame carries it to the client, with the label unchanged",
  );
});

test("with no session Stack the notice names none, for every empty context", async () => {
  const target = tool("ingest_jobs_list");
  for (const empty of [undefined, "", "   "]) {
    const result = await withStackContext(empty, () => target.execute("c", { stackId: "stack-b" }));
    assert.equal(
      result.details.stackNotice,
      "ingest_jobs_list was sent to Stack stack-b; the session had no Stack.",
      `${JSON.stringify(empty)} is no session Stack`,
    );
    assert.doesNotMatch(
      String(result.details.stackNotice),
      /session's Stack/,
      "claiming a session Stack here would describe a request that never happened",
    );
  }
});

test("agreeing, padded, blank and absent arguments produce no notice at all", async () => {
  const target = tool("ingest_jobs_list");
  const before = calls.length;

  const same = await withStackContext("stack-a", () => target.execute("c1", { stackId: "stack-a" }));
  assert.equal("stackNotice" in same.details, false, "agreeing is not a divergence");

  const padded = await withStackContext("stack-a", () => target.execute("c2", { stackId: "  stack-a " }));
  assert.equal("stackNotice" in padded.details, false, "trimmed equality is not a divergence");

  const fallback = await withStackContext("stack-a", () => target.execute("c3", { limit: 5 }));
  assert.equal("stackNotice" in fallback.details, false);
  assert.deepEqual(calls[before + 2]?.args, { limit: 5, stackId: "stack-a" }, "the link is the fallback, silently");

  const blank = await withStackContext("stack-a", () => target.execute("c4", { stackId: "   " }));
  assert.equal("stackNotice" in blank.details, false, "blank is no choice, it is a fallback");
  assert.deepEqual(calls[before + 3]?.args, { stackId: "stack-a" });

  for (const result of [same, padded, fallback, blank]) {
    assert.equal(stackNoticeFromResult(result), undefined);
  }
});

test("the log record fires once per divergent call, with its three fields, beside the notice", async () => {
  const { logger, lines } = logLines();
  const tools = mount([scoped("ingest_jobs_list"), scoped("ingest_job_get")], logger);
  const list = tools.get("ingest_jobs_list");
  const get = tools.get("ingest_job_get");
  assert.ok(list && get);

  const first = await withStackContext("stack-a", () => list.execute("c1", { stackId: "stack-b" }));
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0] ?? "{}");
  assert.equal(record.message, "tool call overrides the turn's Stack");
  assert.equal(record.tool, "ingest_jobs_list");
  assert.equal(record.turnStackId, "stack-a");
  assert.equal(record.argumentStackId, "stack-b");
  assert.equal(
    first.details.stackNotice,
    "ingest_jobs_list was sent to Stack stack-b, not the session's Stack stack-a.",
  );

  // A second divergent call is a second record AND a second, differently attributed
  // sentence — the pair is what the screen and the audit trail have to agree on.
  const second = await withStackContext("stack-a", () => get.execute("c2", { stackId: "stack-b" }));
  assert.equal(lines.length, 2, "one line per overridden call");
  assert.equal(JSON.parse(lines[1] ?? "{}").argumentStackId, "stack-b");
  assert.notEqual(second.details.stackNotice, first.details.stackNotice);

  // Neither an agreeing call nor the silent fallback writes anything.
  await withStackContext("stack-a", () => list.execute("c3", { stackId: "stack-a" }));
  await withStackContext("stack-a", () => list.execute("c4", {}));
  assert.equal(lines.length, 2);
});

test("no source at all is still refused, with the exact copy, and carries no notice", async () => {
  const target = tool("ingest_jobs_list");
  const before = calls.length;
  const result = await withStackContext(undefined, () => target.execute("c", { limit: 5 }));

  assert.equal(result.isError, true);
  assert.equal(
    text(result),
    "ingest_jobs_list works on one Stack, and this turn has no Stack. " +
      "Open the app with a link that names it — ?user=<name>&stackId=<stack-id> — and ask again.",
  );
  assert.equal(calls.length, before, "a refusal never reaches the upstream");
  assert.equal(stackNoticeFromResult(result), undefined, "a refusal is not a divergence");
});

test("a non-string stackId is a type refusal, with no upstream call and no notice", async () => {
  const target = tool("ingest_jobs_list");
  const before = calls.length;
  const result = await withStackContext("stack-a", () => target.execute("c", { stackId: 42 }));

  assert.equal(result.isError, true);
  assert.match(text(result), /takes stackId as a string, and the call sent a number/);
  assert.equal(calls.length, before);
  assert.equal(stackNoticeFromResult(result), undefined);
});

test("a tool that publishes no Stack is not injected and never noticed", async () => {
  const tools = mount([plain("wiki_search")]);
  const target = tools.get("wiki_search");
  assert.ok(target);
  const before = calls.length;
  const result = await withStackContext("stack-a", () => target.execute("c", {}));

  assert.deepEqual(calls[before]?.args, {}, "no Stack is injected into a tool that declared none");
  assert.equal(stackNoticeFromResult(result), undefined);
});

test("the frame stays additive: with nothing to say it is byte-identical to the baseline", async () => {
  // A client that ignores `notice` must close its activity row exactly as it did before
  // this feature existed. The label is unchanged too: the row is closed by matching it.
  const frame = toolFinishedFrame("ingest_jobs_list", false);
  const baseline = JSON.stringify({
    type: "tool_finished",
    tool: "ingest_jobs_list",
    label: toolLabel("ingest_jobs_list"),
    isError: false,
  });
  assert.equal(JSON.stringify(frame), baseline);
  assert.deepEqual(Object.keys(frame), ["type", "tool", "label", "isError"]);

  const withNotice = toolFinishedFrame("ingest_jobs_list", true, "x");
  assert.deepEqual(Object.keys(withNotice), ["type", "tool", "label", "isError", "notice"]);
  assert.deepEqual(withNotice, {
    type: "tool_finished",
    tool: "ingest_jobs_list",
    label: toolLabel("ingest_jobs_list"),
    isError: true,
    notice: "x",
  });
});
