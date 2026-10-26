import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confinedReadOperations, isInsideRoot, PathEscapeError } from "../src/pi/sandbox.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sandbox-"));
  const workspace = join(root, "workspace");
  const agent = join(root, "agent");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(workspace, "notes.txt"), "inside");
  writeFileSync(join(agent, "models.json"), '{"apiKey":"syn_secret"}');
  return { root, workspace, agent };
}

test("reads a file inside the workspace", async () => {
  const { workspace } = fixture();
  const ops = confinedReadOperations(workspace);
  const buffer = await ops.readFile(join(workspace, "notes.txt"));
  assert.equal(buffer.toString(), "inside");
});

test("refuses a sibling directory holding credentials", async () => {
  const { workspace, agent } = fixture();
  const ops = confinedReadOperations(workspace);
  // The exact measured leak: the agent config sits beside the workspace.
  await assert.rejects(ops.readFile(join(agent, "models.json")), PathEscapeError);
});

test("refuses traversal out of the workspace", async () => {
  const { workspace } = fixture();
  const ops = confinedReadOperations(workspace);
  await assert.rejects(ops.readFile(join(workspace, "..", "agent", "models.json")), PathEscapeError);
});

test("refuses an absolute path elsewhere on the filesystem", async () => {
  const { workspace } = fixture();
  const ops = confinedReadOperations(workspace);
  await assert.rejects(ops.readFile("/etc/passwd"), PathEscapeError);
});

test("refuses a symlink that points outside the workspace", async () => {
  const { workspace, agent } = fixture();
  const link = join(workspace, "innocent.txt");
  symlinkSync(join(agent, "models.json"), link);

  const ops = confinedReadOperations(workspace);
  await assert.rejects(ops.readFile(link), PathEscapeError, "the real target must be checked, not the name");
});

test("the refusal message tells the model what happened", async () => {
  const { workspace, agent } = fixture();
  const ops = confinedReadOperations(workspace);
  await assert.rejects(ops.readFile(join(agent, "models.json")), (error: unknown) => {
    assert.match((error as Error).message, /outside the workspace/);
    return true;
  });
});

test("access is confined too, so a metadata probe does not leak existence", async () => {
  const { workspace, agent } = fixture();
  const ops = confinedReadOperations(workspace);
  await assert.rejects(ops.access(join(agent, "models.json")), PathEscapeError);
  await ops.access(join(workspace, "notes.txt"));
});

test("isInsideRoot handles the boundary correctly", () => {
  assert.equal(isInsideRoot("/ws/a.txt", "/ws"), true);
  assert.equal(isInsideRoot("/ws", "/ws"), true);
  assert.equal(isInsideRoot("/ws/sub/a.txt", "/ws"), true);
  assert.equal(isInsideRoot("/ws-other/a.txt", "/ws"), false, "a shared prefix is not containment");
  assert.equal(isInsideRoot("/etc/passwd", "/ws"), false);
});

test("the secret is genuinely unreachable through the confined operations", async () => {
  const { workspace, agent } = fixture();
  const ops = confinedReadOperations(workspace);
  const attempts = [
    join(agent, "models.json"),
    join(workspace, "..", "agent", "models.json"),
    "/etc/passwd",
  ];
  for (const path of attempts) {
    await assert.rejects(async () => {
      const buffer = await ops.readFile(path);
      // Belt and braces: if it ever returned, the test fails on the content.
      assert.ok(!buffer.toString().includes("syn_secret"));
    });
  }
  // And the file really does contain the secret, so the test is not vacuous.
  assert.match(readFileSync(join(agent, "models.json"), "utf8"), /syn_secret/);
});
