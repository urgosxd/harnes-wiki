import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWritableAgentDir } from "../src/pi/agent-dir.ts";

function dirs() {
  const source = mkdtempSync(join(tmpdir(), "src-agent-"));
  const runtime = mkdtempSync(join(tmpdir(), "rt-agent-"));
  return { source, runtime };
}

test("copies models.json and auth.json into a writable directory", async () => {
  const { source, runtime } = dirs();
  writeFileSync(join(source, "models.json"), '{"providers":{}}');
  writeFileSync(join(source, "auth.json"), "{}");

  const result = await prepareWritableAgentDir({ sourceDir: source, runtimeDir: runtime });

  assert.equal(result, runtime);
  assert.ok(existsSync(join(runtime, "models.json")));
  assert.ok(existsSync(join(runtime, "auth.json")));
});

test("the copy is owner-only, because it carries credentials", async () => {
  const { source, runtime } = dirs();
  writeFileSync(join(source, "models.json"), '{"providers":{}}');
  chmodSync(join(source, "models.json"), 0o644);

  await prepareWritableAgentDir({ sourceDir: source, runtimeDir: runtime });

  const mode = statSync(join(runtime, "models.json")).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got 0${mode.toString(8)}`);
});

test("does not copy development resources", async () => {
  const { source, runtime } = dirs();
  writeFileSync(join(source, "models.json"), "{}");
  writeFileSync(join(source, "AGENTS.md"), "# dev instructions");
  writeFileSync(join(source, "settings.json"), "{}");

  await prepareWritableAgentDir({ sourceDir: source, runtimeDir: runtime });

  assert.ok(!existsSync(join(runtime, "AGENTS.md")), "AGENTS.md must not be copied");
  assert.ok(!existsSync(join(runtime, "settings.json")), "settings.json must not be copied");
});

test("a missing auth.json is fine for an api-key-only setup", async () => {
  const { source, runtime } = dirs();
  writeFileSync(join(source, "models.json"), '{"providers":{}}');

  const result = await prepareWritableAgentDir({ sourceDir: source, runtimeDir: runtime });
  assert.equal(result, runtime);
  assert.ok(!existsSync(join(runtime, "auth.json")));
});

test("a source with no credentials at all fails loudly", async () => {
  const { source, runtime } = dirs();
  await assert.rejects(
    prepareWritableAgentDir({ sourceDir: source, runtimeDir: runtime }),
    /no credentials found/,
    "starting without credentials would fail on the first turn instead of at boot",
  );
});

test("the result is writable, which is why the copy exists", async () => {
  const { source, runtime } = dirs();
  writeFileSync(join(source, "auth.json"), "{}");
  await prepareWritableAgentDir({ sourceDir: source, runtimeDir: runtime });

  // Pi takes a lock beside auth.json and recreates the file when missing.
  writeFileSync(join(runtime, "auth.json.lock"), "");
  assert.equal(readFileSync(join(runtime, "auth.json"), "utf8"), "{}");
});
