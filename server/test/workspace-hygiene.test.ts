import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

/**
 * The workspace is what the model can see. Anything the server writes there for its
 * own bookkeeping shows up as a user file: measured, the assistant listed
 * "models-store.json" as one of the user's documents.
 *
 * This is a source-level check because the actual paths are assembled at runtime
 * from configuration; what must hold is that no internal cache or credential path
 * is placed inside the workspace.
 */
const sourceDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function readAll(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readAll(full));
    else if (entry.name.endsWith(".ts")) out.push({ file: full, text: readFileSync(full, "utf8") });
  }
  return out;
}

test("internal caches are not written inside the workspace", () => {
  const offenders: string[] = [];
  for (const { file, text } of readAll(sourceDir)) {
    // A path built by joining the workspace with a name that is not user content.
    for (const match of text.matchAll(/join\(\s*workspaceDir\s*,\s*"([^"]+)"\s*\)/g)) {
      const name = match[1]!;
      if (/store|cache|credential|auth|models\.json|lock/.test(name)) {
        offenders.push(`${file}: ${name}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these internal paths are inside the workspace and visible to the model: ${offenders.join(", ")}`,
  );
});

test("the generated config and the model store live beside the workspace", () => {
  const main = readFileSync(join(sourceDir, "main.ts"), "utf8");
  const runtime = readFileSync(join(sourceDir, "pi", "tenant-runtime.ts"), "utf8");

  assert.match(
    main,
    /resolve\(\s*config\.workspaceDir\s*,\s*"\.\."/,
    "the agent directory must be a sibling of the workspace",
  );
  assert.match(
    runtime,
    /modelsStorePath:\s*join\(\s*workspaceDir\s*,\s*"\.\."/,
    "the model store must be outside the workspace",
  );
});
