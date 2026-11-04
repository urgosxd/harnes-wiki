import { test } from "node:test";
import assert from "node:assert/strict";
import { proxyMcpTools } from "../src/pi/tenant-runtime.ts";
import { currentStackId, withStackContext } from "../src/pi/stack-context.ts";

/**
 * The Stack rule, probed INDEPENDENTLY of the implementation's own tests.
 *
 * Written by the read-only verification pass over `b34a578`, kept as a durable
 * artifact because two of these cases are RED: the scope gate keys off the published
 * schema, so a Stack-scoped tool whose schema does not spell out a flat `stackId`
 * property slips through unscoped. Those are marked `todo` rather than deleted or
 * made to pass, because the fix is a design decision (see BLOCKER B1 in
 * `odd/tasks/multitenant-stackId.md`), and a green suite must not imply the gap is
 * closed.
 *
 * Public surface only: `proxyMcpTools` and the request context. The fake client
 * COUNTS calls, because "returned an error" and "never reached the upstream" are
 * different facts and the second is the one that protects the read scope.
 */

interface Recorded {
  name: string;
  args: Record<string, unknown>;
}

const calls: Recorded[] = [];
const client = {
  async callTool(name: string, args: Record<string, unknown>) {
    calls.push({ name, args });
    return { content: [{ type: "text", text: "ok" }] };
  },
};

interface Descriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A tool that publishes `stackId` the way contract `job-tools.ts@2` does. */
const flat = (name: string): Descriptor => ({
  name,
  description: name,
  inputSchema: {
    type: "object",
    properties: { limit: { type: "integer" }, stackId: { type: "string" } },
  },
});

/** A tool that reads a Stack but publishes a schema with no flat `stackId`. */
const hidden = (name: string): Descriptor => ({
  name,
  description: name,
  inputSchema: { type: "object" },
});

type Mounted = {
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }>;
};

function mount(...descriptors: Descriptor[]): Map<string, Mounted> {
  const tools = proxyMcpTools("probe", client as never, descriptors);
  return new Map(
    tools.map((tool) => {
      const mounted = tool as unknown as Mounted & { name: string };
      return [mounted.name, mounted] as const;
    }),
  );
}

function text(result: { content: Array<{ text?: string }> }): string {
  return result.content.map((block) => block.text ?? "").join("");
}

function tool(name: string): Mounted {
  // One descriptor at a time: mounting both shapes under one name would collide in the
  // map and quietly test the wrong schema.
  const mounted = mount(flat(name)).get(name);
  assert.ok(mounted, `${name} must be mounted`);
  return mounted;
}

test("S9 no context: refused, exact copy, zero upstream calls", async () => {
  const target = tool("ingest_jobs_list");
  const before = calls.length;
  const result = await target.execute("c", { limit: 5 });
  assert.equal(result.isError, true);
  assert.equal(
    text(result),
    "ingest_jobs_list works on one Stack, and this turn has no Stack. " +
      "Open the app with a link that names it — ?user=<name>&stackId=<stack-id> — and ask again.",
  );
  assert.equal(calls.length, before, "an error after a read is still a read");
});

test("S10 omit: the link's Stack is injected and the rest is untouched", async () => {
  const target = tool("ingest_jobs_list");
  const before = calls.length;
  const result = await withStackContext("s-a", () => target.execute("c", { limit: 5 }));
  assert.notEqual(result.isError, true);
  assert.equal(calls.length, before + 1);
  assert.deepEqual(calls[before]?.args, { limit: 5, stackId: "s-a" });
});

test("S10 same: no conflict, no error", async () => {
  const target = tool("ingest_jobs_list");
  const result = await withStackContext("s-a", () => target.execute("c", { stackId: "s-a" }));
  assert.notEqual(result.isError, true);
});

test("S10 conflict: refused, both Stacks named, zero upstream calls", async () => {
  const target = tool("ingest_jobs_list");
  const before = calls.length;
  const result = await withStackContext("s-a", () => target.execute("c", { stackId: "s-b" }));
  assert.equal(result.isError, true);
  assert.match(text(result), /'s-a'/);
  assert.match(text(result), /'s-b'/);
  assert.equal(calls.length, before);
});

test("S12 concurrent turns never share a Stack", async () => {
  const target = tool("ingest_jobs_list");
  let arrived = 0;
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const meet = async (): Promise<void> => {
    arrived += 1;
    if (arrived === 2) release();
    await gate;
  };
  const turn = (stackId: string) =>
    withStackContext(stackId, async () => {
      await meet();
      await target.execute("c", {});
    });
  const before = calls.length;
  await Promise.all([turn("s-a"), turn("s-b")]);
  assert.deepEqual(
    calls.slice(before).map((call) => call.args.stackId),
    ["s-a", "s-b"],
  );
  assert.equal(currentStackId(), undefined, "nothing leaks past the regions");
});

/**
 * D-B1 — WHICH TOOLS ARE STACK-SCOPED.
 *
 * The rule, stated so it cannot drift:
 *
 *   scoped   iff the published schema is unreadable or of unknown shape, OR it is a
 *            readable flat object whose `properties` include `stackId`.
 *   unscoped ONLY when the schema is a readable flat object with `properties` present
 *            that does not include `stackId`.
 *
 * `additionalProperties: true`, `allOf`/`anyOf`/`oneOf`/`$ref`, and an absent
 * `properties` are all UNKNOWN, not "no Stack".
 *
 * The argument is parity, not caution: the baseline injected a Stack into EVERY call
 * without looking at the schema, so treating unknown as scoped can only NARROW the
 * read scope relative to that baseline, never widen it. Judging a hidden schema as
 * "unscoped" would do the opposite — silently, with a success exit.
 *
 * One test per shape, and each shape is asserted on BOTH branches, because the two
 * failures are opposite: unscoped on the read (no context must refuse) and
 * un-injected on the write (context must arrive).
 */
const unknownShapes: Array<[string, Record<string, unknown>]> = [
  ["absent properties", { type: "object" }],
  [
    "additionalProperties: true",
    { type: "object", properties: { limit: { type: "integer" } }, additionalProperties: true },
  ],
  [
    "allOf composition",
    { allOf: [{ type: "object", properties: { stackId: { type: "string" } } }] },
  ],
  ["$ref indirection", { $ref: "#/$defs/listArgs" }],
];

for (const [label, inputSchema] of unknownShapes) {
  test(`unknown shape (${label}): no context refuses and never reaches the upstream`, async () => {
    const target = mount({ name: "wiki_status", description: "wiki_status", inputSchema }).get(
      "wiki_status",
    );
    assert.ok(target);
    const before = calls.length;
    const result = await target.execute("c", { limit: 1 });
    assert.equal(result.isError, true);
    assert.match(text(result), /no Stack/i);
    assert.equal(calls.length, before, "an unscoped read is the failure this rule prevents");
  });

  test(`unknown shape (${label}): the link's Stack is injected`, async () => {
    const target = mount({ name: "wiki_status", description: "wiki_status", inputSchema }).get(
      "wiki_status",
    );
    assert.ok(target);
    const before = calls.length;
    const result = await withStackContext("s-a", () => target.execute("c", { limit: 1 }));
    assert.notEqual(result.isError, true);
    assert.equal(calls[before]?.args.stackId, "s-a");
    assert.equal(calls[before]?.args.limit, 1, "the rest of the arguments survive");
  });
}

test("a readable property list WITHOUT stackId is the only unscoped case", async () => {
  // The one shape where "no Stack" is a fact rather than a guess: the tool publishes
  // its parameters and none of them names a Stack, so injecting would send a field it
  // never declared.
  const target = mount({
    name: "compile_wiki",
    description: "compile_wiki",
    inputSchema: { type: "object", properties: { limit: { type: "integer" } } },
  }).get("compile_wiki");
  assert.ok(target);

  const before = calls.length;
  const withNoContext = await target.execute("c", { limit: 2 });
  assert.notEqual(withNoContext.isError, true);
  assert.deepEqual(calls[before]?.args, { limit: 2 });

  const withContext = await withStackContext("s-a", () => target.execute("c", { limit: 2 }));
  assert.notEqual(withContext.isError, true);
  assert.deepEqual(calls[before + 1]?.args, { limit: 2 }, "no Stack is added to an unscoped tool");
});
