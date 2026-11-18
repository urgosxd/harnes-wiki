import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, getSystemMessageText } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { TenantRuntime } from "../src/pi/tenant-runtime.ts";
import { MemoryEntryStore } from "../src/pi/session-factory.ts";
import { AgentRoleReader, type AgentRoleSource } from "../src/pi/agent-role.ts";
import { withStackContext } from "../src/pi/stack-context.ts";
import { TurnService } from "../src/api/turn-service.ts";
import type { ChatFrame } from "../src/pi/events.ts";
import type { Conversation, ConversationStore, RunRecord } from "../src/db/conversation-store.ts";
import { Logger } from "../src/log.ts";
import { AGENT_DIR, makeWorkspace } from "./support/env.ts";

/**
 * S4, S5 and S6 of `odd/tasks/role-by-volume.md`: the role is TEXT ON DISK, read per turn.
 *
 * Everything here goes through the real `TurnService`, because that is where a turn is
 * actually started: the runtime is cached per user and shared by every conversation that
 * user has, so a role composed once at boot (or captured in the runtime) would look
 * perfectly correct in a unit test of the section text and stay frozen in production —
 * which is the exact failure this feature exists to remove.
 *
 * Two things are observed, and neither is an internal:
 *
 *  * the provider's leading system message, through a faux provider registered on the
 *    runtime's own `ModelRuntime` (the pattern `stack-prompt.test.ts` established). A
 *    section only exists if it reaches the model's own request;
 *  * the frames the client receives, which is where a notice becomes visible to a person.
 *
 * The store is a four-method double: `TurnService` uses `findOwned`, `startRun`,
 * `finishRun` and (through `runTurn`) the entry ledger. Keeping these tests off Postgres
 * is the difference between a guard that runs on every machine and one that skips.
 *
 * No model credentials are involved: the faux provider carries its own auth resolver.
 */

const BASE_PROMPT = "You are a test assistant.";

/** A role file whose body carries a marker unique to this test. */
function roleBody(marker: string): string {
  return (
    "---\n" +
    "name: wiki-agentic-search\n" +
    "description: Agentic search over the wiki.\n" +
    "---\n\n" +
    `# Wiki agentic search\n\n${marker}\n\n` +
    "You answer questions over a compiled wiki by choosing tools in a loop.\n"
  );
}

interface Layout {
  dir: string;
  file: string;
  write(marker: string): void;
  remove(): void;
}

function layout(): Layout {
  const dir = mkdtempSync(join(tmpdir(), "role-per-turn-"));
  const file = join(dir, "wiki-agentic-search.md");
  let current = "";
  return {
    dir,
    file,
    write(marker: string) {
      // A marker plus padding, so a rewrite always changes the SIZE as well as the
      // mtime: the cache keys on both, and a same-size rewrite must not be able to pass
      // by accident on a filesystem with coarse timestamps.
      current = roleBody(marker + " " + "x".repeat(current.length % 7));
      writeFileSync(file, current);
    },
    remove() {
      unlinkSync(file);
    },
  };
}

/** The storage contract `TurnService` uses, and nothing else. */
class TurnStore extends MemoryEntryStore {
  async findOwned(id: string, userId: string): Promise<Conversation | undefined> {
    return {
      id,
      userId,
      title: null,
      piSessionId: id,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      archivedAt: null,
    };
  }

  async startRun(input: { id: string; conversationId: string; idempotencyKey: string }): Promise<{
    status: "created";
    run: RunRecord;
  }> {
    return {
      status: "created",
      run: {
        id: input.id,
        conversationId: input.conversationId,
        idempotencyKey: input.idempotencyKey,
        status: "running",
        stopReason: null,
        errorMessage: null,
        totalTokens: null,
        costTotal: null,
      },
    };
  }

  async finishRun(): Promise<void> {}
}

interface Harness {
  /** Every provider request, in order, as the leading system message plus the rest. */
  observed: { system: string; messages: Message[] }[];
  /** Every frame, per turn, in arrival order. */
  frames: ChatFrame[][];
  /** Everything the reader logged, in arrival order. */
  logged: { level: string; message: string; fields: Record<string, unknown> }[];
  /** How many runtimes were built: the cache the runtime must NOT be read from. */
  runtimes: () => number;
  /** Run one turn and return its frames. */
  turn(conversationId: string): Promise<ChatFrame[]>;
  /** Turn the role file into a selectable source. */
  source: AgentRoleSource;
  close(): Promise<void>;
}

async function harness(roleFile: string, options?: { markWritten?: () => void }): Promise<Harness> {
  const providerId = "role-faux";
  const modelId = "role-1";
  const workspaceDir = makeWorkspace();

  // One user, so the runtime is the SAME cached object on every turn — the case that
  // would freeze a role captured at build time.
  const runtimes: TenantRuntime[] = [];
  const runtimeFor = async (): Promise<TenantRuntime> => {
    const existing = runtimes[0];
    if (existing) return existing;
    const created = await TenantRuntime.create({
      tenant: { id: "role-test", mcpServers: [], exposedMcpTools: [], scopes: [] },
      agentDir: AGENT_DIR,
      workspaceDir,
      systemPrompt: BASE_PROMPT,
      // `get_order` is the one tool this runtime always has, which gives the validation
      // a name that IS provisioned; `search_pages` is the one it never has.
      capabilities: { readTools: false, skills: false },
    });
    runtimes.push(created);
    return created;
  };

  const observed: Harness["observed"] = [];
  const faux = fauxProvider({
    provider: providerId,
    models: [{ id: modelId, contextWindow: 100_000, maxTokens: 4096 }],
  });
  const answer = async (context: { messages: Message[] }) => {
    const system = context.messages.find((message) => message.role === "system");
    observed.push({
      system: system ? getSystemMessageText(system as never) : "",
      messages: context.messages.filter((message) => message.role !== "system"),
    });
    return fauxAssistantMessage("ok");
  };
  faux.setResponses([answer, answer, answer, answer]);

  // The reader logs through a Logger with a capturing sink, so the warning S5/S6 require
  // is observed as the record an operator would grep for, not as a spy on a call.
  const logged: Harness["logged"] = [];
  const log = new Logger({
    level: "debug",
    sink: (line) => {
      const record = JSON.parse(line) as { level: string; message: string } & Record<string, unknown>;
      logged.push({
        level: record.level,
        message: record.message,
        fields: record,
      });
    },
  });
  const reader = new AgentRoleReader({ log });

  const frames: ChatFrame[][] = [];
  const store = new TurnStore();
  let model: Model<never> | undefined;

  const turns = new TurnService({
    store: store as unknown as ConversationStore,
    runtimeFor,
    workspaceDir,
    agentDir: AGENT_DIR,
    modelFor: (runtime) => {
      if (!model) model = runtime.modelRuntime.getModel(providerId, modelId) as unknown as Model<never>;
      assert.ok(model, "the faux model must be registered on the runtime");
      return model;
    },
    thinkingLevel: "off",
    // What `main.ts` wires: the SELECTION is boot-time, the TEXT is read per turn, and
    // the tools the body names are compared against the session's own provisioned set.
    roleForTurn: (runtime) =>
      reader.resolve({ name: "wiki-agentic-search", path: roleFile }, runtime.exposedToolNames),
  });

  // The faux provider has to be registered before the first turn builds a request.
  const warm = await runtimeFor();
  warm.modelRuntime.registerNativeProvider(faux.provider);

  return {
    observed,
    frames,
    logged,
    runtimes: () => runtimes.length,
    source: { name: "wiki-agentic-search", path: roleFile },
    turn: async (conversationId: string) => {
      options?.markWritten?.();
      const started = await turns.start({
        userId: "role-test",
        conversationId,
        message: "hi",
        idempotencyKey: `key-${frames.length}`,
      });
      assert.equal(started.kind, "started", `the turn did not start: ${started.kind}`);
      if (started.kind !== "started") return [];
      const collected: ChatFrame[] = [];
      for await (const frame of started.frames) collected.push(frame);
      frames.push(collected);
      return collected;
    },
    close: async () => {
      for (const runtime of runtimes) await runtime.close();
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(join(roleFile, ".."), { recursive: true, force: true });
    },
  };
}

const warned = (h: Harness, pattern: RegExp): boolean =>
  h.logged.some((entry) => entry.level === "warn" && pattern.test(entry.message));

const noticeOf = (frames: ChatFrame[]): string | undefined => {
  const frame = frames.find((entry) => entry.type === "role_notice");
  return frame && frame.type === "role_notice" ? frame.text : undefined;
};

test("a frontmatter name that no longer matches the selection is refused, not applied", async () => {
  const files = layout();
  files.write("ROLE-TEXT-SELECTED");
  const h = await harness(files.file);
  try {
    await h.turn("conv-identity-1");
    assert.match(h.observed[0]!.system, /ROLE-TEXT-SELECTED/);

    // The identity rule: the applied definition is the one that DECLARES the selected
    // name (`AGENT_DEFINITION=wiki-agentic-search`). An operator who edits that line in
    // the volume is no longer editing the selected role — and the turn must not apply a
    // role under a name this deployment never selected.
    writeFileSync(
      files.file,
      "---\nname: some-other-role\ndescription: Agentic search over the wiki.\n---\n\n" +
        "# Some other role\n\nHIJACKED-BODY\n",
    );
    const frames = await h.turn("conv-identity-2");

    assert.doesNotMatch(
      h.observed[1]!.system,
      /HIJACKED-BODY/,
      "a file that declares another name must not be applied as the selected role",
    );
    assert.match(h.observed[1]!.system, /ROLE-TEXT-SELECTED/, "the last valid text must survive");
    assert.ok(frames.some((frame) => frame.type === "run_finished"), "the turn must still run");
    assert.ok(
      warned(h, /name/i),
      `the mismatch must be logged with the names involved: ${JSON.stringify(h.logged)}`,
    );
    const notice = noticeOf(frames);
    assert.ok(notice, `the person must be told: ${JSON.stringify(frames)}`);
    assert.match(notice ?? "", /some-other-role/, "the notice must name what the file declares");
    assert.match(notice ?? "", /wiki-agentic-search/, "and the name that was selected");
  } finally {
    await h.close();
  }
});

test("editing only the body never disturbs the selection", async () => {
  const files = layout();
  files.write("ROLE-BODY-BEFORE");
  const h = await harness(files.file);
  try {
    await h.turn("conv-body-1");
    // The normal correction path: the frontmatter is untouched, so the identity the
    // selection depends on cannot move. Same declared name, different body.
    files.write("ROLE-BODY-AFTER");
    const frames = await h.turn("conv-body-2");

    assert.match(h.observed[1]!.system, /ROLE-BODY-AFTER/);
    assert.doesNotMatch(h.observed[1]!.system, /ROLE-BODY-BEFORE/);
    assert.equal(noticeOf(frames), undefined, `a body edit is not a problem: ${JSON.stringify(frames)}`);
    assert.equal(
      h.logged.filter((entry) => entry.level === "warn").length,
      0,
      `a body edit must not warn: ${JSON.stringify(h.logged)}`,
    );
  } finally {
    await h.close();
  }
});

test("a role file that was never readable leaves no role, and the turn still runs", async () => {
  // The one branch of S5 with nothing to fall back to. It must not throw: a deployment
  // whose volume was emptied still serves turns, without a role, and says why.
  const files = layout();
  assert.equal(existsSync(files.file), false);
  const h = await harness(files.file);
  try {
    const frames = await h.turn("conv-never");

    assert.ok(frames.some((frame) => frame.type === "run_finished"), "the turn must still run");
    assert.doesNotMatch(h.observed[0]!.system, /# Role:/, "no role text means no role section");
    assert.ok(warned(h, /role/i), `the missing file must be logged: ${JSON.stringify(h.logged)}`);
    assert.match(noticeOf(frames) ?? "", /ran without a role/);
  } finally {
    await h.close();
  }
});

test("the unusable-role warning says which of the two things actually happened", async () => {
  // S5 has TWO outcomes, and one wording for both is a lie in whichever branch it does
  // not describe: a first turn has no valid text to keep, so it ran with no role at all.
  // The exact sentences are pinned here, in both branches, so the words cannot drift away
  // from the behaviour again — a near-miss assertion (`/role/`) would not have caught it.
  const files = layout();
  assert.equal(existsSync(files.file), false);
  const h = await harness(files.file);
  try {
    // Branch 1: never readable, nothing to fall back to.
    await h.turn("conv-wording-none");
    assert.deepEqual(
      h.logged.filter((entry) => entry.level === "warn").map((entry) => entry.message),
      ["agent role could not be read; this turn ran without a role"],
      "a first turn with no readable file must say the turn ran WITHOUT a role",
    );
    assert.equal(
      h.logged.find((entry) => entry.level === "warn")?.fields.hadPrevious,
      false,
      "the record must carry the fact the sentence describes",
    );

    // Branch 2: one good turn first, so there IS a last valid text to keep.
    files.write("ROLE-TEXT-WORDING");
    h.logged.splice(0);
    await h.turn("conv-wording-good");
    assert.deepEqual(
      h.logged.filter((entry) => entry.level === "warn").map((entry) => entry.message),
      [],
      "a readable file must warn about nothing",
    );

    files.remove();
    await h.turn("conv-wording-kept");
    assert.deepEqual(
      h.logged.filter((entry) => entry.level === "warn").map((entry) => entry.message),
      ["agent role could not be read; this turn used the last valid role text"],
      "a later turn with a previous good text must say the text was KEPT",
    );
    assert.equal(
      h.logged.find((entry) => entry.level === "warn")?.fields.hadPrevious,
      true,
      "the record must carry the fact the sentence describes",
    );
  } finally {
    await h.close();
  }
});

test("the role section stays distinguishable from the turn's Stack, and comes first", async () => {
  const files = layout();
  files.write("ROLE-TEXT-ORDER");
  const h = await harness(files.file);
  try {
    // Both sections travel the same seam (`before_agent_start`), so the order they are
    // appended in is the only thing that keeps a reader — and the model — able to tell the
    // standing identity from this turn's fact.
    await withStackContext("stack-order-1", () => h.turn("conv-order"));

    const system = h.observed[0]!.system;
    const roleAt = system.indexOf("# Role: wiki-agentic-search");
    const stackAt = system.indexOf("<session_stack>");
    assert.ok(roleAt > -1, `the role section is missing: ${JSON.stringify(system)}`);
    assert.ok(stackAt > -1, `the Stack section is missing: ${JSON.stringify(system)}`);
    assert.ok(
      roleAt < stackAt,
      "the role must render before the turn's Stack section, not in the middle of it",
    );
    assert.match(system, /stack-order-1/);
  } finally {
    await h.close();
  }
});

test("turn 1 sees role text A, a rewrite to B reaches turn 2 on the same runtime", async () => {
  const files = layout();
  files.write("ROLE-TEXT-A");
  const h = await harness(files.file);
  try {
    await h.turn("conv-a");
    assert.equal(h.observed.length, 1, "the first turn must reach the provider");
    assert.match(
      h.observed[0]!.system,
      /ROLE-TEXT-A/,
      `the role never reached the model: ${JSON.stringify(h.observed[0]!.system)}`,
    );
    // The section extends the session prompt and says what it is.
    assert.ok(h.observed[0]!.system.startsWith(BASE_PROMPT));
    assert.match(h.observed[0]!.system, /# Role: wiki-agentic-search/);

    // The operator fixes the file with the process running: no restart, no rebuild.
    files.write("ROLE-TEXT-B");
    await h.turn("conv-b");

    assert.equal(h.observed.length, 2, "the second turn must reach the provider");
    assert.match(
      h.observed[1]!.system,
      /ROLE-TEXT-B/,
      `the edit did not reach the next turn: ${JSON.stringify(h.observed[1]!.system)}`,
    );
    assert.doesNotMatch(
      h.observed[1]!.system,
      /ROLE-TEXT-A/,
      "the second turn still carried the text the runtime was built with",
    );
    assert.equal(h.runtimes(), 1, "the second turn must reuse the cached runtime, not rebuild it");
  } finally {
    await h.close();
  }
});

test("a deleted role file leaves the last valid text in place, and the turn still runs", async () => {
  const files = layout();
  files.write("ROLE-TEXT-KEPT");
  const h = await harness(files.file);
  try {
    await h.turn("conv-keep-1");
    assert.match(h.observed[0]!.system, /ROLE-TEXT-KEPT/);

    // Mid-life mistake: the file is gone. An editing slip must not leave the agent with
    // no role at all, and must not fail the turn.
    files.remove();
    const frames = await h.turn("conv-keep-2");

    assert.equal(h.observed.length, 2, "the turn must still reach the provider");
    assert.match(
      h.observed[1]!.system,
      /ROLE-TEXT-KEPT/,
      `the last valid role text was lost: ${JSON.stringify(h.observed[1]!.system)}`,
    );
    assert.ok(
      frames.some((frame) => frame.type === "run_finished"),
      "the turn must finish normally, not fail",
    );
    assert.ok(
      warned(h, /role/i),
      `a missing role file must be logged as a warning, got: ${JSON.stringify(h.logged)}`,
    );
    // Visible, not only grep-able: an operator who never reads the log still has to learn
    // that the file they are editing is no longer the one being applied.
    const notice = noticeOf(frames);
    assert.ok(notice, `the person must be told the file could not be read: ${JSON.stringify(frames)}`);
    assert.match(notice ?? "", /could not be read/);
    assert.match(notice ?? "", /wiki-agentic-search\.md/, "the notice must name the file");
  } finally {
    await h.close();
  }
});

test("a role whose frontmatter becomes invalid keeps the last valid text", async () => {
  const files = layout();
  files.write("ROLE-TEXT-GOOD");
  const h = await harness(files.file);
  try {
    await h.turn("conv-refused-1");

    // A YAML block list is refused by the parser rather than half-read (S9). At turn
    // time that refusal is a warning plus the last good text, not a failed turn.
    writeFileSync(
      files.file,
      "---\nname: wiki-agentic-search\ndescription: Edited badly.\ntools:\n  - search_pages\n---\n\nBROKEN-BODY\n",
    );
    const frames = await h.turn("conv-refused-2");

    assert.match(h.observed[1]!.system, /ROLE-TEXT-GOOD/);
    assert.doesNotMatch(h.observed[1]!.system, /BROKEN-BODY/);
    assert.ok(frames.some((frame) => frame.type === "run_finished"));
    assert.ok(warned(h, /role/i), `the refusal must be logged: ${JSON.stringify(h.logged)}`);
  } finally {
    await h.close();
  }
});

test("a role naming an unprovisioned tool says so in the turn's output", async () => {
  const files = layout();
  writeFileSync(
    files.file,
    "---\nname: wiki-agentic-search\ndescription: Agentic search over the wiki.\n---\n\n" +
      "# Wiki agentic search\n\nCall `search_pages` first, then `read_page`.\n",
  );
  const h = await harness(files.file);
  try {
    const frames = await h.turn("conv-missing-tool");

    // The turn runs: a wrong tool list is a deployment fact, not a reason to refuse.
    assert.ok(
      frames.some((frame) => frame.type === "run_finished"),
      `the turn must not fail: ${JSON.stringify(frames)}`,
    );
    assert.ok(
      warned(h, /provision/i),
      `the missing tool must be logged: ${JSON.stringify(h.logged)}`,
    );
    const notice = noticeOf(frames);
    assert.ok(notice, `a visible notice must reach the turn's output: ${JSON.stringify(frames)}`);
    assert.match(notice ?? "", /search_pages/, "the notice must name the missing tool");
    assert.match(notice ?? "", /read_page/);
    // And the agent keeps its role: the body is applied, only the tool list is reported.
    assert.match(h.observed[0]!.system, /Call `search_pages` first/);
  } finally {
    await h.close();
  }
});

test("a role naming only provisioned tools raises no notice", async () => {
  const files = layout();
  // `get_order` is the one tool every tenant runtime has (businessTools in
  // `tenant-runtime.ts`), so a body naming it must produce silence. Without this the
  // notice could be unconditional and every other assertion here would still pass.
  writeFileSync(
    files.file,
    "---\nname: wiki-agentic-search\ndescription: Agentic search over the wiki.\n---\n\n" +
      "# Wiki agentic search\n\nCall `get_order` when the question is about an order.\n",
  );
  const h = await harness(files.file);
  try {
    const frames = await h.turn("conv-provisioned");
    assert.equal(noticeOf(frames), undefined, `no notice was expected: ${JSON.stringify(frames)}`);
    assert.equal(
      h.logged.filter((entry) => entry.level === "warn").length,
      0,
      `nothing should be warned about: ${JSON.stringify(h.logged)}`,
    );
  } finally {
    await h.close();
  }
});
