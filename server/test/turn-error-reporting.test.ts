import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createProvider,
  fauxProvider,
  registerSessionResourceCleanup,
} from "@earendil-works/pi-ai";
import { TenantRuntime } from "../src/pi/tenant-runtime.ts";
import { MemoryEntryStore, runTurn } from "../src/pi/session-factory.ts";
import { AGENT_DIR, makeWorkspace } from "./support/env.ts";

/**
 * S2/S3/S4: a turn that fails must tell the caller WHY.
 *
 * `runTurn` settles the turn inside a `finally` that also returns its result. When the
 * awaited work throws — the model step, or any awaited step before the settlement — the
 * caller used to receive `outcome: "error"` with `errorMessage: undefined`: a turn the
 * user sees fail with no cause at all, because the provider's reason was discarded
 * before it could be reported.
 *
 * Everything here is observed through the public value the caller consumes (the returned
 * `TurnResult`), the public `EntryStore` contract, and the SDK's own session-resource
 * registry — never through an internal field of `runTurn`.
 *
 * No model credentials are involved. The failing turn never needs a reachable provider:
 * its provider has no resolvable auth, so the model request cannot be built at all, and
 * the stream implementation is a tripwire that throws if anything ever reaches it.
 */

const UNAUTHED_PROVIDER = "turn-error-unauthed";
const UNAUTHED_MODEL = "turn-error-1";

const unreachable = (() => {
  throw new Error("the model API must never be reached: this turn fails before its request");
}) as never;

async function runtimeFor(tenantId: string): Promise<{ runtime: TenantRuntime; workspaceDir: string }> {
  const workspaceDir = makeWorkspace();
  const runtime = await TenantRuntime.create({
    tenant: { id: tenantId, mcpServers: [], exposedMcpTools: [], scopes: [] },
    agentDir: AGENT_DIR,
    workspaceDir,
    systemPrompt: "You are a test assistant.",
    capabilities: { readTools: false, skills: false },
  });
  return { runtime, workspaceDir };
}

test("a turn whose model step throws reports the real message", async () => {
  const { runtime, workspaceDir } = await runtimeFor("turn-error-reporting");
  // `session.dispose()` ends in the SDK's session-resource registry, so a cleanup
  // registered here is called exactly when the turn disposes its session.
  const disposedSessions: string[] = [];
  const unregister = registerSessionResourceCleanup((sessionId) => {
    disposedSessions.push(sessionId ?? "");
  });
  try {
    runtime.modelRuntime.registerNativeProvider(
      createProvider({
        id: UNAUTHED_PROVIDER,
        auth: {
          apiKey: {
            name: "Unconfigured key",
            // Not configured, and not available from the environment: the model request
            // cannot be built, so the awaited model step throws.
            resolve: async () => undefined,
          },
        },
        models: [
          {
            id: UNAUTHED_MODEL,
            api: "faux",
            name: "Unconfigured model",
            provider: UNAUTHED_PROVIDER,
            baseUrl: "http://127.0.0.1:0",
            contextWindow: 8_000,
            maxTokens: 256,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
        api: { stream: unreachable, streamSimple: unreachable },
      }),
    );

    const model = runtime.modelRuntime.getModel(UNAUTHED_PROVIDER, UNAUTHED_MODEL);
    assert.ok(model, `the unconfigured model ${UNAUTHED_PROVIDER}/${UNAUTHED_MODEL} must exist`);

    // Records what the turn asked the store to persist, so "the append duty still ran" is
    // a fact about the public store contract instead of a claim about the source.
    const memory = new MemoryEntryStore();
    const appends: number[] = [];
    const store = {
      read: (conversationId: string) => memory.read(conversationId),
      append: async (conversationId: string, entries: Parameters<MemoryEntryStore["append"]>[1]) => {
        appends.push(entries.length);
        await memory.append(conversationId, entries);
      },
    };

    const conversationId = "conv-turn-error-reporting";
    const result = await runTurn({
      runtime,
      store,
      conversationId,
      message: "hi",
      workspaceDir,
      agentDir: AGENT_DIR,
      model,
      thinkingLevel: "off",
    });

    // S4: a throw is never a normal `ok` turn.
    assert.equal(result.outcome, "error", "a throwing model step must be reported as an error turn");
    // S2: the caller learns the real cause instead of `undefined`.
    assert.equal(
      typeof result.errorMessage,
      "string",
      `the failed turn must carry its cause, got: ${JSON.stringify(result.errorMessage)}`,
    );
    assert.match(
      result.errorMessage ?? "",
      new RegExp(`No API key found for ${UNAUTHED_PROVIDER}`),
      `the failed turn must carry the provider's own message, got: ${JSON.stringify(result.errorMessage)}`,
    );

    // S2 (finally duties): the transcript the turn did produce is still persisted. The
    // run records its model and thinking level before the failing call, so on this path
    // there is something to append and the store must have received it.
    assert.ok(result.appended.length > 0, "the failing turn still appended its run-start entries");
    assert.deepEqual(
      appends,
      [result.appended.length],
      "the throwing path must still call store.append once with the turn's entries",
    );
    assert.equal(
      memory.count(conversationId),
      result.appended.length,
      "the throwing path must still persist every entry it appended",
    );

    // S2 (finally duties): the session is still disposed on the throwing path.
    assert.deepEqual(
      disposedSessions,
      [conversationId],
      "the throwing path must still dispose the session it created",
    );
  } finally {
    unregister();
    await runtime.close();
  }
});

test("a model call that fails inside the run still reports the provider's message", async () => {
  const { runtime, workspaceDir } = await runtimeFor("turn-error-transcript");
  try {
    const providerId = "turn-error-faux";
    const faux = fauxProvider({
      provider: providerId,
      models: [{ id: "turn-error-faux-1", contextWindow: 100_000, maxTokens: 4096 }],
    });
    runtime.modelRuntime.registerNativeProvider(faux.provider);
    const model = runtime.modelRuntime.getModel(providerId, "turn-error-faux-1");
    assert.ok(model, `the faux model ${providerId} must be registered`);

    // The provider answers by throwing: the SDK turns that into an assistant message that
    // carries the reason, and the outcome must still come from that persisted message.
    // The wording is deliberately not one the SDK retries, so this turn makes one attempt.
    faux.setResponses([
      async () => {
        throw new Error("the provider rejected this turn's shape");
      },
    ]);

    const conversationId = "conv-turn-error-transcript";
    const store = new MemoryEntryStore();
    const result = await runTurn({
      runtime,
      store,
      conversationId,
      message: "hi",
      workspaceDir,
      agentDir: AGENT_DIR,
      model,
      thinkingLevel: "off",
    });

    assert.equal(result.outcome, "error", "a provider failure must not be reported as ok");
    assert.equal(
      result.errorMessage,
      "the provider rejected this turn's shape",
      "the persisted assistant message's reason must reach the caller",
    );
    assert.ok(result.appended.length > 0, "the failing turn must append its transcript");
    assert.equal(
      store.count(conversationId),
      result.appended.length,
      "the failing turn must persist the transcript it appended",
    );
  } finally {
    await runtime.close();
  }
});
