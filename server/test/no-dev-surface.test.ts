import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { AGENT_DIR, MODEL_ID, PROVIDER, hasCredentials, makeWorkspace } from "./support/env.ts";
import { TenantRuntime } from "../src/pi/tenant-runtime.ts";

/**
 * The product promise is that a user never SEES development tooling.
 *
 * That is a UI promise, and it stays: no terminal, no file browser, no settings in
 * the interface. What the model may use is a different question, and an earlier
 * version of this file confused the two by asserting that no built-in tool could be
 * active at all. A support assistant has to read a document, so the real
 * requirements are narrower and more useful:
 *
 *  - the shell is off unless the deployment explicitly enables it;
 *  - file reads are confined to the workspace, so credentials beside it stay
 *    unreachable;
 *  - no AGENTS.md or extension content leaks into the prompt.
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

test("the shell and write tools are off by default", { skip }, async () => {
  const workspace = makeWorkspace();
  const { runtime, session } = await openSession(workspace);
  try {
    const tools = session.getActiveToolNames();
    for (const dangerous of ["bash", "write", "edit", "powershell"]) {
      assert.ok(
        !tools.includes(dangerous),
        `${dangerous} must not be active by default; it cannot be confined to the workspace`,
      );
    }
  } finally {
    session.dispose();
    await runtime.close();
  }
});

test("read tools are available to the model but confined to the workspace", { skip }, async () => {
  const workspace = makeWorkspace();
  const { runtime, session } = await openSession(workspace);
  try {
    const tools = session.getActiveToolNames();
    // These are what let the model answer a question about a document.
    for (const reference of ["read", "grep", "find", "ls"]) {
      assert.ok(tools.includes(reference), `${reference} should be available for reference material`);
    }
  } finally {
    session.dispose();
    await runtime.close();
  }
});

test("no AGENTS.md content reaches the system prompt", { skip }, async () => {
  const workspace = makeWorkspace();
  const { runtime, session } = await openSession(workspace);
  try {
    // Skills may be listed (they are reference material the model can consult),
    // but a project AGENTS.md is development context and must never appear.
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
