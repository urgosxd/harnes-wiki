import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_DIR, MODEL_ID, PROVIDER, hasCredentials } from "./support/harness.ts";
import { TenantRuntime } from "../src/pi/tenant-runtime.ts";

/**
 * The agent directory passed to the runtime must be the agent directory it uses.
 *
 * `ModelRuntime.create()` without explicit paths resolves credentials through HOME
 * and PI_CODING_AGENT_DIR. On a developer machine that happens to equal
 * ~/.pi/agent, so the bug is invisible until deployment: in a container the default
 * resolved to 0 models and every start died with "model is not available". This
 * test runs the runtime with a HOME that has no Pi configuration, which is the
 * container's condition.
 */

const skip = hasCredentials() ? false : "no Pi credentials on this machine";

test("the runtime finds models through its agent dir, not through HOME", { skip }, async () => {
  const emptyHome = mkdtempSync(join(tmpdir(), "no-pi-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "portable-ws-"));

  const originalHome = process.env.HOME;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  // A clean HOME and no agent-dir override: exactly what a container has.
  process.env.HOME = emptyHome;
  delete process.env.PI_CODING_AGENT_DIR;

  const runtime = await TenantRuntime.create({
    tenant: { id: "portable", mcpServers: [], exposedMcpTools: [], scopes: [] },
    agentDir: AGENT_DIR,
    workspaceDir: workspace,
    systemPrompt: "x",
  });

  try {
    const models = await runtime.modelRuntime.getAvailable();
    assert.ok(
      models.length > 0,
      "no models were resolved: the runtime is reading credentials from HOME instead of the agent dir",
    );
    assert.ok(
      runtime.modelRuntime.getModel(PROVIDER, MODEL_ID),
      `model ${PROVIDER}/${MODEL_ID} must be reachable through the passed agent dir`,
    );
  } finally {
    process.env.HOME = originalHome;
    if (originalAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await runtime.close();
  }
});

test("the model store is written to the workspace, not into the read-only agent dir", { skip }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "store-ws-"));
  const readOnlyAgentDir = mkdtempSync(join(tmpdir(), "ro-agent-"));
  mkdirSync(readOnlyAgentDir, { recursive: true });
  // A minimal models.json so the runtime has something to read.
  writeFileSync(
    join(readOnlyAgentDir, "models.json"),
    JSON.stringify({ providers: {} }),
    "utf8",
  );
  writeFileSync(join(readOnlyAgentDir, "auth.json"), JSON.stringify({}), "utf8");

  const runtime = await TenantRuntime.create({
    tenant: { id: "store", mcpServers: [], exposedMcpTools: [], scopes: [] },
    agentDir: readOnlyAgentDir,
    workspaceDir: workspace,
    systemPrompt: "x",
  });

  try {
    // Creating the runtime must not have written into the agent dir; the store
    // lives beside the workspace so a read-only mount is fine.
    const agentDirEntries = execFileSync("ls", ["-1", readOnlyAgentDir], { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean)
      .sort();
    assert.deepEqual(
      agentDirEntries,
      ["auth.json", "models.json"],
      "the runtime must not write cache files into the agent dir",
    );
  } finally {
    await runtime.close();
  }
});
