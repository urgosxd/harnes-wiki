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

test("text reaches the client before the turn finishes", { skip }, async () => {
  const workspace = makeWorkspace();
  const runtime = await runtimeFor(workspace);
  try {
    const deltas: string[] = [];
    let firstDeltaAt: number | undefined;

    // Whether a reply arrives as one chunk or many is the provider's choice, so a
    // chunk count says nothing about this code. The property that matters is
    // temporal: text must reach the client while the run is still going, which is
    // what lets the browser paint instead of waiting for the whole answer.
    // The prompt asks for long output so the answer cannot plausibly be one chunk.
    const result = await runTurn({
      runtime,
      store: new MemoryEntryStore(),
      conversationId: "conv-stream",
      message:
        "Write exactly three short sentences about the sea, one per line. No preamble.",
      workspaceDir: workspace,
      agentDir: AGENT_DIR,
      model: modelFor(runtime),
      thinkingLevel: "off",
      hooks: {
        onTextDelta: (delta) => {
          firstDeltaAt ??= Date.now();
          deltas.push(delta);
        },
      },
    });
    const turnEndedAt = Date.now();

    assert.equal(result.outcome, "ok", `turn failed: ${result.errorMessage}`);
    assert.ok(firstDeltaAt !== undefined, "no text delta reached the client at all");
    assert.equal(deltas.join(""), result.text, "streamed text must equal the final text");

    // A replayed-at-the-end implementation would show firstDeltaAt at the turn's
    // end. Requiring the first delta to land well before that end is what makes
    // this test fail when the streaming is faked.
    const lead = turnEndedAt - firstDeltaAt;
    assert.ok(
      lead >= 20,
      `first delta arrived ${lead}ms before the turn ended, which looks like a replay at the end rather than streaming`,
    );
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

