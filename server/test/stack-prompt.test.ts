import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxProvider, getSystemMessageText } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import { TenantRuntime } from "../src/pi/tenant-runtime.ts";
import { MemoryEntryStore, runTurn } from "../src/pi/session-factory.ts";
import { withStackContext } from "../src/pi/stack-context.ts";
import { AGENT_DIR, makeWorkspace } from "./support/env.ts";

/**
 * S2 of `odd/tasks/stack-in-prompt.md`: what the MODEL receives names the turn's Stack.
 *
 * The observation is the provider request itself, never the return value of our own
 * composition: a faux provider is registered on the runtime's `ModelRuntime`, and its
 * response factory is handed the `TranscriptContext` the provider is about to send. What
 * our handler produced is only real if it appears in the leading system message of that
 * request — the gap a unit test of the section text would paper over (S8).
 *
 * No model credentials are involved: the faux provider answers with a canned assistant
 * message and carries its own auth resolver, so this file cannot skip into a green.
 */

const BASE_PROMPT = "You are a test assistant.";

/** What the provider was handed for one request. */
interface ObservedRequest {
  /** The leading system message: the text the model reads first. */
  system: string;
  /** Every non-system message, in order. */
  messages: Message[];
}

interface Harness {
  observed: ObservedRequest[];
  /** Run one turn with `stackId` as the request's Stack (`undefined` = a link with none). */
  run(stackId: string | undefined, conversationId: string, message?: string): ReturnType<typeof runTurn>;
  close(): Promise<void>;
}

/**
 * A runtime whose model is a faux provider that records the request it receives.
 *
 * `before` may hold the request open, which is how the concurrency case proves two turns
 * are really in flight together instead of merely sequential.
 */
async function harness(options?: {
  providerId?: string;
  /** How many requests the provider will be asked to answer. */
  requests?: number;
  before?: (observed: ObservedRequest) => Promise<void>;
}): Promise<Harness> {
  const providerId = options?.providerId ?? "stackprompt-faux";
  const modelId = "stackprompt-1";
  // One workspace for the whole test: the rendered prompt carries the cwd, and comparing
  // two turns of the same runtime must not differ by that.
  const workspaceDir = makeWorkspace();

  const runtime = await TenantRuntime.create({
    tenant: { id: "stack-prompt-test", mcpServers: [], exposedMcpTools: [], scopes: [] },
    agentDir: AGENT_DIR,
    workspaceDir,
    systemPrompt: BASE_PROMPT,
    capabilities: { readTools: false, skills: false },
  });

  const observed: ObservedRequest[] = [];
  const faux = fauxProvider({
    provider: providerId,
    models: [{ id: modelId, contextWindow: 100_000, maxTokens: 4096 }],
  });
  const answer = async (context: { messages: Message[] }) => {
    const system = context.messages.find((message) => message.role === "system");
    const request: ObservedRequest = {
      system: system ? getSystemMessageText(system as never) : "",
      messages: context.messages.filter((message) => message.role !== "system"),
    };
    observed.push(request);
    await options?.before?.(request);
    return fauxAssistantMessage("ok");
  };
  faux.setResponses(Array.from({ length: options?.requests ?? 1 }, () => answer));

  runtime.modelRuntime.registerNativeProvider(faux.provider);
  const model = runtime.modelRuntime.getModel(providerId, modelId);
  assert.ok(model, `the faux model ${providerId}/${modelId} must be registered on the runtime`);

  const store = new MemoryEntryStore();
  const runOne = (conversationId: string, message: string) =>
    runTurn({
      runtime,
      store,
      conversationId,
      message,
      workspaceDir,
      agentDir: AGENT_DIR,
      model,
      thinkingLevel: "off",
    });

  return {
    observed,
    run: (stackId, conversationId, message = "hi") =>
      stackId === undefined
        ? runOne(conversationId, message)
        : withStackContext(stackId, () => runOne(conversationId, message)),
    close: () => runtime.close(),
  };
}

test("the provider's leading system prompt names the turn's Stack", async () => {
  const { observed, run, close } = await harness();
  try {
    const message = "ingest this into my stack";
    const result = await run("stack-alpha", "conv-stack-prompt", message);

    assert.equal(result.outcome, "ok", `the turn failed: ${result.errorMessage}`);
    assert.equal(observed.length, 1, "the provider must be asked exactly once");

    const system = observed[0]!.system;
    assert.match(
      system,
      /stack-alpha/,
      `the model was never told the turn's Stack, it received: ${JSON.stringify(system)}`,
    );
    // The words a person actually uses must resolve to that Stack (S1).
    assert.match(system, /my stack/i);
    assert.match(system, /this stack/i);
    // How the Stack reaches a tool, and the listing it must not consult instead.
    assert.match(system, /stackId/);
    assert.match(system, /list_stacks/);
    // Appended to the prompt the runtime chose, never replacing it.
    assert.ok(
      system.startsWith(BASE_PROMPT),
      `the Stack section must extend the session prompt, got: ${JSON.stringify(system)}`,
    );

    // The user's own text is not rewritten (S2).
    const user = observed[0]!.messages.find((entry) => entry.role === "user");
    assert.ok(user, "the request must carry the user's message");
    assert.match(JSON.stringify(user), new RegExp(message), "the user's text must travel as typed");
    // The section is projected onto the request, so the transcript keeps its own shape.
    assert.doesNotMatch(
      JSON.stringify(result.appended),
      /list_stacks/,
      "the Stack section must not be recorded in the transcript",
    );
  } finally {
    await close();
  }
});

test("a second turn of the same runtime sees its own Stack, not the first one's", async () => {
  // One runtime, one user: the cached object the Stack must NOT be read from (S3).
  const { observed, run, close } = await harness({
    providerId: "stackprompt-faux-perturn",
    requests: 2,
  });
  try {
    assert.equal((await run("stack-one", "conv-a")).outcome, "ok");
    assert.equal((await run("stack-two", "conv-b")).outcome, "ok");

    assert.equal(observed.length, 2, "each turn must be one request");
    assert.match(observed[0]!.system, /stack-one/);
    assert.doesNotMatch(
      observed[0]!.system,
      /stack-two/,
      "the first turn saw a Stack that did not exist yet",
    );
    assert.match(observed[1]!.system, /stack-two/);
    assert.doesNotMatch(
      observed[1]!.system,
      /stack-one/,
      "the second turn inherited the first turn's Stack from the cached runtime",
    );
  } finally {
    await close();
  }
});

test("a turn with no Stack gets no Stack section at all", async () => {
  const { observed, run, close } = await harness({
    providerId: "stackprompt-faux-nostack",
    requests: 2,
  });
  try {
    const withoutStack = await run(undefined, "conv-no-stack");
    const withStack = await run("stack-alpha", "conv-with-stack");

    assert.equal(withoutStack.outcome, "ok", `the turn failed: ${withoutStack.errorMessage}`);
    assert.equal(withStack.outcome, "ok", `the turn failed: ${withStack.errorMessage}`);
    assert.equal(observed.length, 2);

    const bare = observed[0]!.system;
    assert.doesNotMatch(bare, /list_stacks/, `nothing may be added without a Stack, got: ${JSON.stringify(bare)}`);
    assert.doesNotMatch(bare, /stackId/);
    assert.doesNotMatch(bare, /my stack/i);

    // The only difference between the two requests is the section itself: same runtime,
    // same workspace, same conversationless transcript, one Stack (S4).
    const section = observed[1]!.system.slice(bare.length);
    assert.ok(
      observed[1]!.system.startsWith(bare),
      `adding a Stack must not rewrite the rest of the prompt, got: ${JSON.stringify(observed[1]!.system)}`,
    );
    assert.match(section, /stack-alpha/);
    assert.match(section, /list_stacks/);
  } finally {
    await close();
  }
});

test("two turns in flight at once each read their own Stack", async () => {
  // The shape that breaks a value captured at build time or kept on the runtime (S5).
  let arrived = 0;
  let release = (): void => {};
  const bothArrived = new Promise<void>((resolve) => {
    release = resolve;
  });

  const { observed, run, close } = await harness({
    providerId: "stackprompt-faux-concurrent",
    requests: 2,
    before: async () => {
      arrived += 1;
      if (arrived === 2) release();
      // Neither request is answered until both are provably in flight.
      const guard = setTimeout(release, 5_000);
      await bothArrived;
      clearTimeout(guard);
    },
  });
  try {
    const [first, second] = await Promise.all([run("stack-x", "conv-c1"), run("stack-y", "conv-c2")]);
    assert.equal(first.outcome, "ok", `first turn failed: ${first.errorMessage}`);
    assert.equal(second.outcome, "ok", `second turn failed: ${second.errorMessage}`);

    assert.equal(observed.length, 2, "both turns must reach the provider");
    const carryingX = observed.filter((request) => request.system.includes("stack-x"));
    const carryingY = observed.filter((request) => request.system.includes("stack-y"));
    assert.equal(carryingX.length, 1, "exactly one request names stack-x");
    assert.equal(carryingY.length, 1, "exactly one request names stack-y");
    assert.notEqual(carryingX[0], carryingY[0], "one request must not carry both Stacks");
  } finally {
    await close();
  }
});
