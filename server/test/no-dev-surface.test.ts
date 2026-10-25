import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { AGENT_DIR, MODEL_ID, PROVIDER, hasCredentials, makeWorkspace } from "./support/env.ts";
import { TenantRuntime } from "../src/pi/tenant-runtime.ts";

/**
 * The product promise is that a user never sees development tooling. That is not a
 * UI decision: it is which tools the model can call and what the system prompt says.
 */

const skip = hasCredentials() ? false : "no Pi credentials on this machine";

const DEV_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"];

async function openSession(workspace: string, scopes: string[] = []) {
  const runtime = await TenantRuntime.create({
    tenant: { id: "no-dev", mcpServers: [], exposedMcpTools: [], scopes },
    agentDir: AGENT_DIR,
    workspaceDir: workspace,
    systemPrompt: "You are a helpful assistant.",
  });
  const model = runtime.modelRuntime.getModel(PROVIDER, MODEL_ID);
  assert.ok(model);

  const { session } = await createAgentSession({
    cwd: workspace,
    agentDir: AGENT_DIR,
    modelRuntime: runtime.modelRuntime,
    model,
    resourceLoader: runtime.resourceLoader,
    settingsManager: runtime.settingsManager,
    sessionManager: SessionManager.inMemory(workspace),
    noTools: "builtin",
    customTools: runtime.customTools,
    tools: runtime.toolNames,
  });
  await session.bindExtensions({
    mode: "print",
    commandContextActions: {
      waitForIdle: () => session.waitForIdle(),
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: async () => ({ cancelled: true }),
      switchSession: async () => ({ cancelled: true }),
      reload: async () => {},
    },
    onError: () => {},
  });
  return { runtime, session };
}

test("no built-in development tool is active", { skip }, async () => {
  const workspace = makeWorkspace();
  const { runtime, session } = await openSession(workspace);
  try {
    const tools = session.getActiveToolNames();
    const leaked = DEV_TOOLS.filter((name) => tools.includes(name));
    assert.deepEqual(leaked, [], `development tools leaked into the session: ${leaked.join(", ")}`);
  } finally {
    session.dispose();
    await runtime.close();
  }
});

test("no skill or AGENTS.md content reaches the system prompt", { skip }, async () => {
  const workspace = makeWorkspace();
  const { runtime, session } = await openSession(workspace);
  try {
    assert.doesNotMatch(session.systemPrompt, /<skills>/);
    assert.doesNotMatch(session.systemPrompt, /AGENTS\.md/);
  } finally {
    session.dispose();
    await runtime.close();
  }
});

test("the system prompt still carries a cwd section, so it must be a neutral one", { skip }, async () => {
  const workspace = makeWorkspace();
  const { runtime, session } = await openSession(workspace);
  try {
    // Documented behaviour, not a bug: Pi appends <cwd> even with an override.
    // The product relies on the workspace never being a real project directory.
    assert.match(session.systemPrompt, /<cwd>/);
  } finally {
    session.dispose();
    await runtime.close();
  }
});

test("a tenant without a scope gets business tools but no permission to use them", { skip }, async () => {
  const workspace = makeWorkspace();
  const { runtime, session } = await openSession(workspace, []);
  try {
    assert.ok(session.getActiveToolNames().includes("get_order"));

    const result = await runtime.customTools
      .find((tool) => (tool as unknown as { name?: string }).name === "get_order")!
      .execute("call-1", { orderId: "9" } as never, undefined, undefined, undefined as never);

    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /forbidden/);
  } finally {
    session.dispose();
    await runtime.close();
  }
});
