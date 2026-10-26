import { test } from "node:test";
import assert from "node:assert/strict";
import { humanize, skillsInOutput, toolLabel } from "../src/pi/activity.ts";

test("known tools get a readable label", () => {
  assert.equal(toolLabel("read"), "Reading a document");
  assert.equal(toolLabel("grep"), "Searching the workspace");
  assert.equal(toolLabel("ls"), "Checking the workspace");
  assert.equal(toolLabel("get_order"), "Looking up an order");
});

test("an MCP tool is described by its data source, not its identifier", () => {
  const label = toolLabel("mcp__crm__order_lookup");
  assert.match(label, /order lookup/i);
  assert.match(label, /crm/i);
  assert.doesNotMatch(label, /mcp__/, "the raw identifier must not reach the user");
});

test("an unknown tool gets a neutral phrase instead of its name", () => {
  const label = toolLabel("some_internal_thing_v2");
  assert.equal(label, "Using a tool");
  assert.doesNotMatch(label, /some_internal/);
});

test("humanize turns identifiers into words", () => {
  assert.equal(humanize("order_lookup"), "order lookup");
  assert.equal(humanize("find-files"), "find files");
  assert.equal(humanize("  Mixed_Case  "), "mixed case");
});

test("skill names are read from an output block", () => {
  const output = 'before <skill name="support-guide">content</skill> after';
  assert.deepEqual(skillsInOutput(output), ["support-guide"]);
});

test("several skills in one chunk are all reported, without duplicates", () => {
  const output = '<skill name="a"></skill><skill name="b"></skill><skill name="a"></skill>';
  assert.deepEqual(skillsInOutput(output).sort(), ["a", "b"]);
});

test("text with no skill block reports nothing and never throws", () => {
  assert.deepEqual(skillsInOutput("just an answer"), []);
  assert.deepEqual(skillsInOutput("<skill>unclosed"), []);
  assert.deepEqual(skillsInOutput(""), []);
});

test("a skill split across chunks reports nothing until it is complete", () => {
  // The parser is deliberately stateless: a partial tag must not invent a name.
  assert.deepEqual(skillsInOutput('<skill na'), []);
  assert.deepEqual(skillsInOutput('me="half">'), []);
});
