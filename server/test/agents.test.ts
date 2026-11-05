import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeSystemPrompt,
  loadAgentDefinitions,
  parseAgentDefinition,
  unsupportedKeysFor,
} from "../src/pi/agents.ts";

/**
 * Agent definitions are product content the operator edits, so every mistake has to
 * surface at startup with the file and the key named. Pi core has no discovery for
 * these files; the product composes the prompt itself, which makes this parser the
 * only thing standing between a typo and a silently ignored role.
 *
 * Unsupported keys are the one deliberate exception. An operator who mounts an
 * existing pi-herdsman agents directory carries `tools`, `model` and `thinking`, and
 * rejecting the whole directory would make this feature unusable for exactly the
 * definitions it exists to consume. The parse is lenient and reports the keys; the
 * strictness lives in the selection, which is what a later test pins.
 */

/** A definition document as the loader reads it from disk. */
function doc(name: string, description: string, body = `# ${name}\n\nBody.`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

/** Run `fn` and return the error message, failing the test when nothing throws. */
function messageFrom(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof Error, `expected an Error, got ${String(error)}`);
    return error.message;
  }
  return assert.fail("expected the call to throw");
}

test("parses name, description and body from a valid definition", () => {
  const source = `---
name: documentor
description: Answers questions about the indexed documentation.
---

# Documentor

Answer only from what you read.`;

  const { definition, unsupportedKeys } = parseAgentDefinition(source, "documentor.md");

  assert.equal(definition.name, "documentor");
  assert.equal(definition.description, "Answers questions about the indexed documentation.");
  assert.equal(definition.body, "# Documentor\n\nAnswer only from what you read.");
  assert.deepEqual(unsupportedKeys, []);
});

test("a missing or empty description fails with the file and the key named", () => {
  const missing = "---\nname: documentor\n---\n\nBody.";
  assert.equal(
    messageFrom(() => parseAgentDefinition(missing, "a.md")),
    'a.md: missing required frontmatter key "description"',
  );

  const empty = "---\nname: documentor\ndescription:   \n---\n\nBody.";
  assert.equal(
    messageFrom(() => parseAgentDefinition(empty, "a.md")),
    'a.md: missing required frontmatter key "description"',
  );

  const noName = "---\ndescription: Answers questions.\n---\n\nBody.";
  assert.equal(
    messageFrom(() => parseAgentDefinition(noName, "a.md")),
    'a.md: missing required frontmatter key "name"',
  );
});

test("a line that is not key: value still fails the file", () => {
  const source = "---\nname: documentor\ndescription: Answers questions.\n# a comment\n---\n\nBody.";
  assert.equal(
    messageFrom(() => parseAgentDefinition(source, "a.md")),
    'a.md: frontmatter line 4 is not "key: value": "# a comment"',
  );
});

test("a key this runtime cannot honor is reported instead of thrown", () => {
  // `model` is what a host pi-herdsman definition carries. Rejecting the file would
  // also reject every definition in a mounted pi-herdsman directory, so the parse
  // succeeds and names the key for the caller to judge.
  const source = `---
name: documentor
description: Answers questions.
model: anthropic/claude-sonnet-4
tools: read, bash
thinking: high
---

Body.`;

  const { definition, unsupportedKeys } = parseAgentDefinition(source, "a.md");

  assert.equal(definition.name, "documentor");
  assert.deepEqual(unsupportedKeys, ["model", "tools", "thinking"]);
});

test("loads every definition, keyed by name in filename order, skipping README.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-"));
  try {
    writeFileSync(join(dir, "b-documentor.md"), doc("documentor", "Answers questions."));
    writeFileSync(join(dir, "a-helper.md"), doc("helper", "Helps with tasks."));
    writeFileSync(join(dir, "README.md"), "# Agent definitions\n\nNotes, not a definition.\n");

    const { definitions, unsupported } = loadAgentDefinitions(dir);

    assert.equal(definitions.size, 2);
    assert.deepEqual([...definitions.keys()], ["helper", "documentor"]);
    assert.equal(definitions.get("helper")?.description, "Helps with tasks.");
    assert.deepEqual(unsupported, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one file with unsupported keys does not stop the load, and is recorded alone", () => {
  // The verified failure this rule exists for: a bind-mounted pi-herdsman directory
  // used to fail the boot for every definition in it, even with nothing selected.
  const dir = mkdtempSync(join(tmpdir(), "agents-"));
  try {
    writeFileSync(
      join(dir, "a-herdsman.md"),
      "---\nname: herdsman\ndescription: Ported role.\ntools: read\n" +
        "model: anthropic/claude-sonnet-4\n---\n\nBody.\n",
    );
    writeFileSync(join(dir, "b-documentor.md"), doc("documentor", "Answers questions."));

    const { definitions, unsupported } = loadAgentDefinitions(dir);

    assert.deepEqual([...definitions.keys()], ["herdsman", "documentor"]);
    assert.deepEqual(unsupported, [
      { file: join(dir, "a-herdsman.md"), keys: ["tools", "model"] },
    ]);
    assert.deepEqual(unsupportedKeysFor({ definitions, unsupported }, "herdsman"), [
      "tools",
      "model",
    ]);
    assert.deepEqual(unsupportedKeysFor({ definitions, unsupported }, "documentor"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unsupportedKeysFor is empty for a definition that carries no extra keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-"));
  try {
    writeFileSync(join(dir, "a.md"), doc("documentor", "Answers questions."));

    const loaded = loadAgentDefinitions(dir);

    assert.deepEqual(loaded.unsupported, []);
    assert.deepEqual(unsupportedKeysFor(loaded, "documentor"), []);
    // A name that was never loaded carries no keys either: it is not this helper's
    // job to report a missing definition, and the selection already fails on that.
    assert.deepEqual(unsupportedKeysFor(loaded, "absent"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two files claiming the same name fail, naming both files", () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-"));
  try {
    writeFileSync(join(dir, "a.md"), doc("documentor", "Answers questions."));
    writeFileSync(join(dir, "b.md"), doc("documentor", "Does the same, differently."));

    assert.equal(
      messageFrom(() => loadAgentDefinitions(dir)),
      `${join(dir, "a.md")} and ${join(dir, "b.md")} both define agent "documentor"`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing directory is not an error: the mount is optional", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "agents-")), "absent");
  try {
    const { definitions, unsupported } = loadAgentDefinitions(dir);
    assert.equal(definitions.size, 0);
    assert.deepEqual(unsupported, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("composing the prompt keeps the base first and appends the role", () => {
  const { definition } = parseAgentDefinition(doc("documentor", "Answers questions."), "d.md");
  const composed = composeSystemPrompt("BASE PROMPT", definition);

  assert.equal(
    composed,
    `BASE PROMPT\n\n# Role: documentor\n\nAnswers questions.\n\n${definition.body}`,
  );
  assert.ok(composed.startsWith("BASE PROMPT"), "the base prompt stays first and unmodified");
});
