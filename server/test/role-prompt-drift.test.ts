import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxProvider, getSystemMessageText } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import { TenantRuntime } from "../src/pi/tenant-runtime.ts";
import { MemoryEntryStore, runTurn } from "../src/pi/session-factory.ts";
import { composeSystemPrompt, parseAgentDefinition, type AgentDefinition } from "../src/pi/agents.ts";
import { withRoleContext } from "../src/pi/agent-role.ts";
import { withStackContext } from "../src/pi/stack-context.ts";
import { AGENT_DIR, makeWorkspace } from "./support/env.ts";

/**
 * The ORDER of the rendered system prompt, pinned — because it moved once and must not
 * move again by accident.
 *
 * Until this feature the role was composed at boot: `main.ts` built
 * `<base prompt> + # Role: …` and handed the result to Pi as the session prompt, so Pi's
 * own sections landed AFTER it. The rendered prompt was
 *
 *     base prompt → # Role: … → <cwd> → <session_stack>
 *
 * The role now lands through `before_agent_start`, which appends to a prompt Pi has
 * already rendered, so it arrives after the `<cwd>` block Pi contributes:
 *
 *     base prompt → <cwd> → # Role: … → <session_stack>
 *
 * That is the ACCEPTED order, not a defect: no text is lost, the role body is
 * byte-identical, and the standing identity (`# Role: …`) still comes before the turn's
 * own fact (`<session_stack>`). Reordering Pi's sections to restore the old position would
 * be hand-surgery on another component's output for zero semantic gain. This file pins
 * what we accepted so a FUTURE change that moves either block fails here instead of being
 * discovered in a diff.
 *
 * Both tests observe the provider's own leading system message — the text the model
 * actually reads — never the return value of our composition, and never the section
 * builder's own string. No model credentials are involved: the faux provider carries its
 * own auth resolver, so neither test can skip into a green.
 */

const BASE_PROMPT = "You are a test assistant.";
const STACK_ID = "stack-drift";

/** A role whose body carries a marker unique to this file. */
const ROLE_FILE_TEXT =
  "---\nname: probe-role\ndescription: A probe role.\n---\n\n" +
  "# Probe role\n\nPROBE-BODY-LINE\n";

function probeDefinition(body = "PROBE-BODY-LINE"): AgentDefinition {
  const { definition } = parseAgentDefinition(
    ROLE_FILE_TEXT.replace("PROBE-BODY-LINE", body),
    "probe-role.md",
  );
  return definition;
}

/** Pi's own section, as Pi renders it into the prompt it hands our handler. */
const CWD_BLOCK = /\n*<cwd>\n[\s\S]*?\n<\/cwd>/g;

/**
 * The prompt with Pi's `<cwd>` block taken out.
 *
 * The block is a fact about THIS machine's workspace path, not about the role, so it is
 * the one part of the two compositions that cannot be equal by construction — and the one
 * the ordering change moved. Removing it is what lets the comparison assert everything
 * else is untouched: same base prompt, same role text, same Stack section, same order
 * between them.
 */
const withoutCwd = (prompt: string): string => prompt.replace(CWD_BLOCK, "");

interface Harness {
  /** Every leading system message the provider was handed, in arrival order. */
  observed: string[];
  /** Run one turn of this runtime, with the given role and Stack on its async chain. */
  run(input: {
    conversationId: string;
    role?: AgentDefinition;
    stackId?: string;
    before?: () => Promise<void>;
  }): Promise<void>;
  close(): Promise<void>;
}

/**
 * One runtime, one faux provider that records what it is asked to answer.
 *
 * `systemPrompt` is the only knob that differs between the two compositions: the boot
 * shape hands in `composeSystemPrompt(base, definition)`, the per-turn shape hands in the
 * bare base prompt and carries the role on the async chain instead. `before` may hold a
 * request open, which is how the concurrency case proves two turns are really in flight
 * together rather than merely sequential.
 */
async function harness(options: {
  providerId: string;
  systemPrompt: string;
  requests: number;
  workspaceDir?: string;
}): Promise<Harness> {
  const modelId = "drift-1";
  const workspaceDir = options.workspaceDir ?? makeWorkspace();

  const runtime = await TenantRuntime.create({
    tenant: { id: "role-drift-test", mcpServers: [], exposedMcpTools: [], scopes: [] },
    agentDir: AGENT_DIR,
    workspaceDir,
    systemPrompt: options.systemPrompt,
    capabilities: { readTools: false, skills: false },
  });

  const observed: string[] = [];
  const faux = fauxProvider({
    provider: options.providerId,
    models: [{ id: modelId, contextWindow: 100_000, maxTokens: 4096 }],
  });
  const answer = async (context: { messages: Message[] }) => {
    const system = context.messages.find((message) => message.role === "system");
    observed.push(system ? getSystemMessageText(system as never) : "");
    return fauxAssistantMessage("ok");
  };
  faux.setResponses(Array.from({ length: options.requests }, () => answer));

  runtime.modelRuntime.registerNativeProvider(faux.provider);
  const model = runtime.modelRuntime.getModel(options.providerId, modelId);
  assert.ok(model, `the faux model ${options.providerId}/${modelId} must be registered`);

  const store = new MemoryEntryStore();

  return {
    observed,
    run: async ({ conversationId, role, stackId, before }) => {
      const one = () =>
        runTurn({
          runtime,
          store,
          conversationId,
          message: "hi",
          workspaceDir,
          agentDir: AGENT_DIR,
          model,
          thinkingLevel: "off",
        });
      // The two values travel the same seam (`before_agent_start`) and are read on the
      // turn's own chain; wrapping is how the test puts them there, exactly as
      // `turn-service.ts` does for a real turn.
      const withStack = () => (stackId === undefined ? one() : withStackContext(stackId, () => one()));
      if (role === undefined) {
        const result = await withStack();
        assert.equal(result.outcome, "ok", `the turn failed: ${result.errorMessage}`);
        await before?.();
        return;
      }
      const result = await withRoleContext(role, withStack);
      assert.equal(result.outcome, "ok", `the turn failed: ${result.errorMessage}`);
      await before?.();
    },
    close: () => runtime.close(),
  };
}

test("the role lands after Pi's <cwd> block and before the Stack section, and nothing else moved", async () => {
  // One workspace for both compositions: the rendered prompt carries the cwd, and a
  // comparison of two turns must not differ by which directory they ran in.
  const workspaceDir = makeWorkspace();
  const definition = probeDefinition();

  // The composition this feature replaced, observed the same way: the boot string handed
  // to Pi as the session prompt, which is why Pi's own sections follow it.
  const boot = await harness({
    providerId: "drift-faux-boot",
    systemPrompt: composeSystemPrompt(BASE_PROMPT, definition),
    requests: 1,
    workspaceDir,
  });
  // The composition that ships now: the bare base prompt, the role appended per turn.
  const perTurn = await harness({
    providerId: "drift-faux-perturn",
    systemPrompt: BASE_PROMPT,
    requests: 1,
    workspaceDir,
  });

  try {
    await boot.run({ conversationId: "conv-drift-boot", stackId: STACK_ID });
    await perTurn.run({ conversationId: "conv-drift-perturn", role: definition, stackId: STACK_ID });

    assert.equal(boot.observed.length, 1, "the boot composition must be one request");
    assert.equal(perTurn.observed.length, 1, "the per-turn composition must be one request");
    const before = boot.observed[0]!;
    const now = perTurn.observed[0]!;

    // 1. EXACTLY ONE role heading. Two would mean the section was appended twice — a
    //    runtime holding a role and a turn appending it again — which is the failure this
    //    test exists to catch, and it is invisible in a substring assertion.
    assert.equal(
      now.match(/# Role:/g)?.length,
      1,
      `the role heading must appear exactly once, got: ${JSON.stringify(now)}`,
    );

    // 2. THE DOCUMENTED ORDER: Pi's cwd block first, then the role, then the turn's Stack.
    const cwdAt = now.indexOf("<cwd>");
    const roleAt = now.indexOf("# Role: probe-role");
    const stackAt = now.indexOf("<session_stack>");
    assert.ok(cwdAt > -1, `Pi's cwd block is missing: ${JSON.stringify(now)}`);
    assert.ok(roleAt > -1, `the role section is missing: ${JSON.stringify(now)}`);
    assert.ok(stackAt > -1, `the Stack section is missing: ${JSON.stringify(now)}`);
    assert.ok(
      cwdAt < roleAt,
      `the role must land after Pi's <cwd> block, got: ${JSON.stringify(now)}`,
    );
    assert.ok(
      roleAt < stackAt,
      `the role must land before the turn's Stack section, got: ${JSON.stringify(now)}`,
    );

    // 3. EVERYTHING ELSE IS UNCHANGED. With Pi's cwd block out of both, the boot
    //    composition and the per-turn one are the same bytes: same base prompt, same role
    //    text, same Stack section, same relative order. That is what makes the position
    //    change acceptable rather than a content change — and what still catches any OTHER
    //    drift, since any difference in text or order fails this equality.
    assert.equal(
      withoutCwd(now),
      withoutCwd(before),
      "apart from Pi's <cwd> block the two prompts must be identical",
    );

    // The base prompt is still first and unmodified, and the role still extends it rather
    // than replacing it.
    assert.ok(
      now.startsWith(BASE_PROMPT),
      `the role must extend the session prompt, got: ${JSON.stringify(now)}`,
    );
    assert.match(now, /PROBE-BODY-LINE/, "the role body must reach the model");
  } finally {
    await boot.close();
    await perTurn.close();
  }
});

test("the role is composed per turn: a second turn sees the new text, and two turns in flight do not mix", async () => {
  // One runtime, one user: the cached object a role must NOT be captured in. The role is
  // read per turn and applied on that turn's own async chain, so neither a later turn nor
  // a concurrent one can inherit a stale or foreign section (S4).
  let arrived = 0;
  let release = (): void => {};
  const bothArrived = new Promise<void>((resolve) => {
    release = resolve;
  });

  const h = await harness({
    providerId: "drift-faux-per-turn",
    systemPrompt: BASE_PROMPT,
    requests: 3,
  });

  const gate = async (): Promise<void> => {
    arrived += 1;
    if (arrived === 2) release();
    // The first two requests wait for each other, so both turns are provably in flight at
    // the same time; the third turn runs after they have finished.
    if (arrived <= 2) await bothArrived;
  };

  try {
    const first = probeDefinition("ROLE-TEXT-A");
    const second = probeDefinition("ROLE-TEXT-B");

    // Two turns at once on the SAME runtime, each with its own role text.
    await Promise.all([
      h.run({ conversationId: "conv-drift-a", role: first, stackId: STACK_ID, before: gate }),
      h.run({ conversationId: "conv-drift-b", role: second, stackId: STACK_ID, before: gate }),
    ]);

    assert.equal(h.observed.length, 2, "both concurrent turns must have reached the provider");
    const concurrent = h.observed.map((system) => ({
      system,
      marker: /ROLE-TEXT-A/.test(system) ? "A" : /ROLE-TEXT-B/.test(system) ? "B" : "none",
      headings: system.match(/# Role:/g)?.length ?? 0,
    }));
    assert.deepEqual(
      concurrent.map((entry) => entry.marker).sort(),
      ["A", "B"],
      `each concurrent turn must carry its own role text: ${JSON.stringify(concurrent.map((e) => e.marker))}`,
    );
    for (const entry of concurrent) {
      // A turn that carried both texts would mean the role leaked across the chain.
      assert.equal(
        entry.headings,
        1,
        `a concurrent turn appended the role more than once: ${JSON.stringify(entry.system)}`,
      );
    }

    // A third turn, after the first two, sees the role it is given — not the one the
    // cached runtime was built under, and not the last one appended to some shared buffer.
    await h.run({ conversationId: "conv-drift-c", role: second, stackId: STACK_ID });
    const third = h.observed[2]!;
    assert.match(third, /ROLE-TEXT-B/);
    assert.doesNotMatch(
      third,
      /ROLE-TEXT-A/,
      "a later turn inherited a role that was never its own",
    );
    assert.equal(third.match(/# Role:/g)?.length, 1, "the role section must not accumulate");
    assert.ok(
      third.indexOf("# Role: probe-role") < third.indexOf("<session_stack>"),
      "the order pinned in the first test must hold on every turn, not only the first",
    );
  } finally {
    await h.close();
  }
});
