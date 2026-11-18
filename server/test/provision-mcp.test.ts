import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deprecatedDefaultStack,
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
 * attention — so the two drifted: `server/agents/wiki-agentic-search.md` instructs the
 * model to call `read_page` and `query_stack`, and neither was provisioned. A role
 * that asks for tools the agent does not have is the failure these tests exist to
 * make impossible to ship.
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
 * Two spellings have to be read, because the body uses both. Four tools are named in
 * their fully qualified form (`mcp__llmwiki__read_page`), which is what the model is
 * handed and therefore the authoritative spelling; `query_stack` and `list_stacks`
 * are named bare, in backticks, in the prose about the graph dimension. Reading only
 * the prefixed ones would have missed exactly the tool that was missing.
 *
 * The bare pattern is deliberately greedy about snake_case identifiers: a role that
 * mentions `some_tool` in prose is asking for it, and a false positive here fails
 * closed — loudly, at test time — instead of shipping a role that cannot call what it
 * was told to call.
 */
function roleTools(): Set<string> {
  const body = readFileSync(ROLE, "utf8");
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
  // assertion below would pass while pinning nothing at all. `read_page` arrives
  // prefixed and `query_stack` only bare, so both extraction paths are proven live.
  assert.ok(needed.has("read_page"), "the fully qualified spelling must be extracted");
  assert.ok(needed.has("query_stack"), "the bare spelling must be extracted");

  const missing = [...needed].filter((name) => !TOOLS.includes(name)).sort();
  assert.deepEqual(
    missing,
    [],
    `the role instructs the model to call tools that are not provisioned: ${missing.join(", ")}`,
  );
});

test("no mutating tool is provisioned", () => {
  const granted = MUTATING_TOOLS.filter((name) => TOOLS.includes(name));
  assert.deepEqual(
    granted,
    [],
    `these tools write to the wiki host and must not be granted: ${granted.join(", ")}`,
  );
});
