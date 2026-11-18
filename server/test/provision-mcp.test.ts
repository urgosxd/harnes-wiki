import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkHostGrants,
  deprecatedDefaultStack,
  fetchHostTools,
  parseToolsList,
  TOOLS,
  warnDeprecatedDefaultStack,
} from "../scripts/provision-mcp.mjs";

/**
 * WHY THESE EXIST
 *
 * `MCP_DEFAULT_STACK_ID` used to be REQUIRED here, on purpose: omitting it made every
 * agent call inherit whatever Stack the remote host happened to be bound to, and that
 * binding moved under us once (2026-10-28: an empty Stack, and the agent truthfully
 * told the user their wiki had 0 pages).
 *
 * The Stack now travels with the request instead, so this variable is neither read nor
 * written any more. Two failures are possible and both are pinned:
 *
 *  1. Making it required again would refuse to provision anyone who has not set a
 *     variable that no longer does anything.
 *  2. Silence would leave operators believing it still scopes their reads. Ignoring a
 *     value without saying so is the worse of the two: it looks like it worked.
 *
 * So: absence provisions silently, presence warns exactly once, and neither path
 * fails. Nothing here writes a Stack to storage — the stored column is tolerated and
 * left alone.
 */

test("absent variable provisions without failing and without a warning", () => {
  const lines: string[] = [];
  const value = warnDeprecatedDefaultStack({}, (line) => lines.push(line));
  assert.equal(value, null, "an unset variable must not produce a value");
  assert.deepEqual(lines, [], "there is nothing to warn about when nothing was set");
});

test("a set variable is ignored, and says so exactly once", () => {
  const lines: string[] = [];
  const value = warnDeprecatedDefaultStack(
    { MCP_DEFAULT_STACK_ID: "b8b8e801-b423-4a32-ab0b-e1ea2d82ead8" },
    (line) => lines.push(line),
  );
  // Returned only so the warning can be specific; nothing consumes it as a Stack.
  assert.equal(value, "b8b8e801-b423-4a32-ab0b-e1ea2d82ead8");
  assert.equal(lines.length, 1, "one warning per run, not one per user");
  assert.match(lines[0] ?? "", /deprecated/i);
  assert.match(lines[0] ?? "", /ignored/i);
  // The message must not imply the value still scopes anything.
  assert.doesNotMatch(lines[0] ?? "", /required/i);
});

test("a blank variable is the same as an absent one", () => {
  const lines: string[] = [];
  assert.equal(warnDeprecatedDefaultStack({ MCP_DEFAULT_STACK_ID: "   " }, (l) => lines.push(l)), null);
  assert.deepEqual(lines, [], "whitespace is not a value worth warning about");
});

test("the parser trims, so a copied id is not a different one", () => {
  assert.equal(
    deprecatedDefaultStack({ MCP_DEFAULT_STACK_ID: "  abc  " }),
    "abc",
  );
});

/**
 * WHY THESE EXIST
 *
 * The shipped role is a copy of a definition written against a host that had the wiki
 * tools, and its body names the tools it will call. The grant list lives in a
 * different file, in a different language, maintained by a different person's
 * attention — so the two drifted: `server/agents/wiki-agentic-search.md` instructed the
 * model to call `read_page` and it was not provisioned. A role that asks for tools the
 * agent does not have is the failure these tests exist to make impossible to ship.
 *
 * The role speaks in two dimensions, page reads and graph reads, and the guard below
 * demands one name from each: a body that stopped naming either half would otherwise
 * pass a subset check while pinning nothing.
 *
 * The comparison is a SUBSET, deliberately, not equality. The role needing six tools
 * says what the role must be able to do; it does not say the deployment may expose
 * only those six. Provisioning is also where the operator grants read-only tools this
 * role happens not to name, and an equality pin would forbid that for no reason
 * anyone asked for. What may not happen is a role tool going ungranted, or a mutating
 * tool going granted — and both of those are pinned here.
 */

// The shipped role file, not an installed copy: this is the artifact the image seeds.
const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROLE = join(serverRoot, "agents", "wiki-agentic-search.md");

/**
 * Writes. The product never decided to expose these, and the role is read-only by
 * construction, so the list is spelled out rather than inferred: a mutating tool that
 * appears here without a decision is a defect, and inferring "mutating" from a name
 * would let a new one slip through under a friendly spelling.
 */
const MUTATING_TOOLS = [
  "ingest_source",
  "compile_wiki",
  "export_okf",
  "import_okf",
  "run_eval",
];

/**
 * Every MCP tool the role's body tells the model to call.
 *
 * Two spellings are read, and the reason each one is still read is different now.
 *
 * The BARE spelling — a snake_case name in backticks — is what the shipped body uses:
 * after `role-by-volume` (S2) there is one MCP host and the role names its tools the way
 * the model is handed them, with no server-name prefix. `tenant_mcp.exposed_tools` holds
 * bare names too (`src/pi/tenant-runtime.ts` intersects them with each connected server's
 * own `listTools()`), so a prefixed spelling in the body would be describing a tool that
 * cannot be granted at all.
 *
 * The QUALIFIED spelling (`mcp__llmwiki__read_page`) is read for the opposite reason: it
 * is the spelling a role copied from a multi-host deployment arrives with, and a body
 * that regresses to it must still have its tool coverage checked rather than being read
 * as prose. The shipped body does not use it — `test` below pins that.
 *
 * The bare pattern is deliberately greedy about snake_case identifiers: a role that
 * mentions `some_tool` in prose is asking for it, and a false positive here fails
 * closed — loudly, at test time — instead of shipping a role that cannot call what it
 * was told to call.
 */
function roleTools(body: string = readFileSync(ROLE, "utf8")): Set<string> {
  const names = new Set<string>();
  for (const match of body.matchAll(/\bmcp__[A-Za-z0-9_]+?__([a-z][a-z0-9_]*)/g)) {
    names.add(match[1]!);
  }
  for (const match of body.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) {
    names.add(match[1]!);
  }
  return names;
}

test("every MCP tool the shipped role names is provisioned", () => {
  const needed = roleTools();
  // A guard against the vacuous pass: if the extractor stops matching, the coverage
  // assertion below would pass while pinning nothing at all. One name from each
  // dimension the body talks about, so a body that stopped naming tools entirely is
  // caught here instead of passing a subset check against an empty set.
  assert.ok(needed.has("search_pages"), "the page-retrieval tools must be extracted");
  assert.ok(needed.has("query_stack"), "the graph dimension's read must be extracted");

  const missing = [...needed].filter((name) => !TOOLS.includes(name)).sort();
  assert.deepEqual(
    missing,
    [],
    `the role instructs the model to call tools that are not provisioned: ${missing.join(", ")}`,
  );
});

/**
 * S2 of `odd/tasks/role-by-volume.md`: ONE MCP host, named the way the model is handed it.
 *
 * `mcp__…__tool` is a multi-server spelling: it names a server, so a role written that way
 * only works while the deployment keeps that server's name, and it describes a tool
 * `exposed_tools` cannot match. `llmwiki_kg` was the second host the requester removed.
 * Both are pinned absent rather than merely unmentioned, because either one reappearing is
 * the exact regression this spec exists for.
 */
test("the shipped role names its tools bare, with no second host", () => {
  const body = readFileSync(ROLE, "utf8");

  assert.doesNotMatch(
    body,
    /mcp__/,
    "the body must not use a host-qualified tool spelling: one MCP host, named bare",
  );
  assert.doesNotMatch(
    body,
    /llmwiki_kg/,
    "the body must not refer to the second (knowledge-graph) host",
  );
});

test("the qualified spelling is still extracted, so a regression is measured", () => {
  // Proven on a body written the old way: the extractor's first pattern is not dead code
  // kept "just in case" — it is what keeps a role copied from a multi-host deployment
  // covered by the subset check above instead of being read as prose.
  const legacy = "Call `mcp__llmwiki__read_page` and `mcp__llmwiki_kg__query_stack`.";
  const needed = roleTools(legacy);
  assert.deepEqual([...needed].sort(), ["query_stack", "read_page"]);
});

test("no mutating tool is provisioned", () => {
  const granted = MUTATING_TOOLS.filter((name) => TOOLS.includes(name));
  assert.deepEqual(
    granted,
    [],
    `these tools write to the wiki host and must not be granted: ${granted.join(", ")}`,
  );
});

test("the grant list has no duplicate names", () => {
  // The reported count is `TOOLS.length`, and a duplicate would inflate it: ten distinct
  // capabilities would read as eleven, which is the same lie the drift check exists to
  // stop telling.
  assert.deepEqual(
    TOOLS.filter((name, index) => TOOLS.indexOf(name) !== index),
    [],
    "a name appears twice, so the reported tool count overstates what is granted",
  );
});

/**
 * WHY THESE EXIST
 *
 * The grant list is copied into the server image (`server/Dockerfile`: `COPY scripts
 * ./scripts`), because a deployed host has no source tree. That copy is a fork in
 * practice: the published image of 2026-11-18 still ships the eleven-name list with
 * `verify_artifact`, and running it writes a grant for a tool the host does not publish.
 * The runtime intersects `exposed_tools` with the host's own names, so the row is
 * silently narrowed to nothing — "provisioned 11 tool(s)" with ten working tools, and no
 * error anywhere.
 *
 * The fix is to stop guessing: ask the host what it publishes and refuse to write a list
 * it cannot honour. The tests below pin the three ways that can go wrong — an SSE body
 * read as "no tools", a refused `tools/list` read as "no tools", and a stale list written
 * over a correct one.
 */

test("tools/list is read out of an SSE body and out of plain JSON", () => {
  const sse = [
    "event: message",
    'data: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"search_pages"},{"name":"query_stack"}]}}',
    "",
  ].join("\n");
  assert.deepEqual(parseToolsList(sse), { tools: ["search_pages", "query_stack"], nextCursor: undefined });

  const plain = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "read_page" }] } });
  assert.deepEqual(parseToolsList(plain), { tools: ["read_page"], nextCursor: undefined });
});

test("an error answer is raised, never read as a host with no tools", () => {
  // A JSON-RPC error means the host refused. Calling that an empty tool set would blame
  // the grant list for a host problem, and the operator would "fix" the wrong thing.
  assert.throws(
    () => parseToolsList('data: {"jsonrpc":"2.0","id":1,"error":{"message":"unauthorized"}}'),
    /unauthorized/,
  );
  assert.throws(() => parseToolsList("data: not json at all"), /result\.tools/);
});

test("the host is asked with the headers the transport requires, and pages are followed", async () => {
  const requests: Array<{ url: unknown; init: any }> = [];
  const answers = [
    {
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "search_pages" }], nextCursor: "page-2" },
    },
    { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "query_stack" }, { name: "search_pages" }] } },
  ];
  const fetchImpl = async (url: unknown, init: any) => {
    requests.push({ url, init });
    return new Response(`event: message\ndata: ${JSON.stringify(answers[requests.length - 1])}\n\n`);
  };

  const names = await fetchHostTools("http://hub.test/mcp", { fetchImpl });

  assert.deepEqual(names, ["search_pages", "query_stack"], "pages are merged and de-duplicated");
  assert.equal(requests.length, 2, "a nextCursor must be followed, not dropped");
  const first = requests[0]!.init;
  assert.equal(first.method, "POST");
  assert.match(String(first.headers.accept), /text\/event-stream/, "406 without it");
  assert.equal(JSON.parse(first.body).method, "tools/list");
  assert.deepEqual(JSON.parse(requests[1]!.init.body).params, { cursor: "page-2" });
});

test("an unreachable host names the escape hatch instead of throwing a fetch error", async () => {
  const fetchImpl = async () => {
    throw new Error("getaddrinfo ENOTFOUND hub.test");
  };
  await assert.rejects(
    () => fetchHostTools("http://hub.test/mcp", { fetchImpl }),
    (error: Error) => /ENOTFOUND/.test(error.message) && /--skip-drift-check/.test(error.message),
  );
});

test("the stale-image list is refused, naming the tool that does not exist", () => {
  // The exact measurement that motivated this check: the host publishes seventeen tools
  // and none of them is `verify_artifact`; the baked script still grants it.
  const stale = [...TOOLS, "verify_artifact"];

  assert.throws(
    () => checkHostGrants(TOOLS, { url: "http://hub.test/mcp", granted: stale }),
    (error: Error) => {
      assert.match(error.message, /does not publish verify_artifact/);
      assert.match(error.message, /Nothing was written/);
      assert.match(error.message, /baked into an older server image/);
      return true;
    },
  );
});

test("the current list passes, and tools left ungranted are reported rather than failed", () => {
  const published = [...TOOLS, "ingest_source", "compile_wiki", "run_eval"];
  const report = checkHostGrants(published, { url: "http://hub.test/mcp" });

  assert.equal(report.published, published.length);
  assert.equal(report.granted, TOOLS.length);
  // Writes are deliberately withheld. Reporting them is audit; failing on them would
  // make the product's own read-only rule look like drift.
  assert.deepEqual(report.dropped, ["compile_wiki", "ingest_source", "run_eval"]);
});
