import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_DIR, MODEL_ID, PROVIDER, hasCredentials, makeWorkspace } from "./support/env.ts";
import { TenantRuntime } from "../src/pi/tenant-runtime.ts";
import { MemoryEntryStore, runTurn } from "../src/pi/session-factory.ts";

/**
 * T2 acceptance: one conversation, two turns, and the second turn must recall what
 * the first one said after the whole session object has been thrown away.
 *
 * The recall has to come from the stored entries. Nothing is kept alive between
 * turns, which is what makes a restart survivable.
 */

const skip = hasCredentials() ? false : "no Pi credentials on this machine";

async function runtimeFor(workspace: string): Promise<TenantRuntime> {
  return TenantRuntime.create({
    tenant: { id: "test-tenant", mcpServers: [], exposedMcpTools: [], scopes: [] },
    agentDir: AGENT_DIR,
    workspaceDir: workspace,
    systemPrompt:
      "You are a concise assistant. Answer in as few words as possible. " +
      "When asked to remember something, remember it exactly.",
  });
}

function modelFor(runtime: TenantRuntime) {
  const model = runtime.modelRuntime.getModel(PROVIDER, MODEL_ID);
  assert.ok(model, `model ${PROVIDER}/${MODEL_ID} is not available`);
  return model;
}

test("a conversation recalls its first turn after the session is rebuilt", { skip }, async () => {
  const workspace = makeWorkspace();
  const runtime = await runtimeFor(workspace);
  try {
    const store = new MemoryEntryStore();
    const conversationId = "conv-recall";
    const model = modelFor(runtime);

    const first = await runTurn({
      runtime,
      store,
      conversationId,
      message: "Remember this code: 4417. Reply with exactly OK.",
      workspaceDir: workspace,
      agentDir: AGENT_DIR,
      model,
      thinkingLevel: "off",
    });

    assert.equal(first.outcome, "ok", `first turn failed: ${first.errorMessage}`);
    assert.ok(first.appended.length > 0, "the first turn must append entries");
    assert.ok(store.count(conversationId) > 0, "the store must hold the first turn");

    // Simulate a process restart: nothing but the serialized entries survives.
    const restarted = MemoryEntryStore.restore(conversationId, store.dump(conversationId));
    const runtimeAfterRestart = await runtimeFor(workspace);
    try {
      const second = await runTurn({
        runtime: runtimeAfterRestart,
        store: restarted,
        conversationId,
        message: "What code did I ask you to remember? Reply with just the number.",
        workspaceDir: workspace,
        agentDir: AGENT_DIR,
        model: modelFor(runtimeAfterRestart),
        thinkingLevel: "off",
      });

      assert.equal(second.outcome, "ok", `second turn failed: ${second.errorMessage}`);
      assert.match(
        second.text,
        /4417/,
        `the rebuilt session did not recall the first turn, got: ${JSON.stringify(second.text)}`,
      );
    } finally {
      await runtimeAfterRestart.close();
    }
  } finally {
    await runtime.close();
  }
});

/**
 * What this test can and cannot prove.
 *
 * It proves the wiring: every text delta the model produced reaches the hook, in
 * order, and equals the final text. That is load-independent.
 *
 * It deliberately does NOT assert a wall-clock lead between the first delta and
 * the end of the turn. That assertion was tried and is flaky by nature: on a busy
 * machine the provider can deliver the whole answer in one read after a stall, so
 * the margin collapses even though the code is correct. Ordering is proven where
 * it is deterministic instead - FrameQueue tests (a pushed frame resolves a
 * waiting consumer) and the HTTP measurement in test/http-api.test.ts, where the
 * live stream showed a 775ms lead across 13 distinct arrival timestamps.
 */
test("every streamed delta reaches the hook and matches the final text", { skip }, async () => {
  const workspace = makeWorkspace();
  const runtime = await runtimeFor(workspace);
  try {
    const deltas: string[] = [];

    const result = await runTurn({
      runtime,
      store: new MemoryEntryStore(),
      conversationId: "conv-stream",
      message: "Count from one to three, in words, on one line.",
      workspaceDir: workspace,
      agentDir: AGENT_DIR,
      model: modelFor(runtime),
      thinkingLevel: "off",
      hooks: { onTextDelta: (delta) => deltas.push(delta) },
    });

    assert.equal(result.outcome, "ok", `turn failed: ${result.errorMessage}`);
    assert.ok(deltas.length >= 1, "no text delta reached the client at all");
    assert.equal(deltas.join(""), result.text, "streamed text must equal the final text");
  } finally {
    await runtime.close();
  }
});

test("a failing provider is reported as an error turn, not as success", { skip }, async () => {
  const workspace = makeWorkspace();
  const runtime = await runtimeFor(workspace);
  try {
    const bogus = runtime.modelRuntime.getModel(PROVIDER, MODEL_ID);
    assert.ok(bogus);

    const result = await runTurn({
      runtime,
      store: new MemoryEntryStore(),
      conversationId: "conv-error",
      message: "Say something.",
      workspaceDir: workspace,
      agentDir: AGENT_DIR,
      // A model id the provider rejects. prompt() resolves anyway, so the outcome
      // must come from the persisted assistant message.
      model: { ...bogus, id: "syn:model-that-does-not-exist" },
      thinkingLevel: "off",
    });

    assert.equal(result.outcome, "error");
    assert.ok(result.errorMessage, "the provider message must be preserved");
  } finally {
    await runtime.close();
  }
});

test("a store that rejects the append surfaces the failure", { skip }, async () => {
  const workspace = makeWorkspace();
  const runtime = await runtimeFor(workspace);
  try {
    const failing = {
      read: async () => [],
      append: async () => {
        throw new Error("database is down");
      },
    };

    await assert.rejects(
      runTurn({
        runtime,
        store: failing,
        conversationId: "conv-fail-store",
        message: "Remember 1.",
        workspaceDir: workspace,
        agentDir: AGENT_DIR,
        model: modelFor(runtime),
        thinkingLevel: "off",
      }),
      /database is down/,
    );
  } finally {
    await runtime.close();
  }
});

