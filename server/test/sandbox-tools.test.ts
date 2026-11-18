import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentTools } from "../src/pi/agent-tools.ts";
import { PathEscapeError, resolveRequestedPath } from "../src/pi/sandbox.ts";

/**
 * `read` was confined to the workspace by `confinedReadOperations`; `grep`, `find`
 * and `ls` were not. Measured on the committed tree, with the agent config one
 * directory above the workspace:
 *
 *   read  ../agent/models.json -> refused: ... is outside the workspace
 *   ls    ../agent            -> models.json
 *   grep  ../agent/models.json -> models.json:1: {"apiKey":"syn_secret"}
 *   find  ../agent             -> models.json
 *
 * These tests drive the tool instances `createAgentTools` really mounts, so what is
 * asserted is the refusal the model sees, not an internal helper: a path outside the
 * workspace must be refused with the same vocabulary `read` uses, for an absolute
 * path, for `..` traversal and for a symlink whose name looks contained. The inside
 * cases pin that the three tools still answer exactly what they answered before.
 */

type ToolLike = {
  name: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
};

/** The workspace and the sibling directory holding the credential, as deployed. */
function fixture(options: { symlinks?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sandbox-tools-"));
  const workspace = join(root, "workspace");
  const agent = join(root, "agent");
  mkdirSync(join(workspace, "sub"), { recursive: true });
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(workspace, "notes.txt"), "inside line\n");
  writeFileSync(join(workspace, "sub", "deep.txt"), "inside deep line\n");
  writeFileSync(join(agent, "models.json"), '{"apiKey":"syn_secret"}\n');
  if (options.symlinks) {
    // Names inside the workspace that resolve outside it.
    symlinkSync(join(agent, "models.json"), join(workspace, "innocent.json"));
    symlinkSync(agent, join(workspace, "escape-dir"), "dir");
    // And one that resolves to nothing, so the link itself has to be read.
    symlinkSync(join(agent, "nope.json"), join(workspace, "dangling.json"));
  }
  return { root, workspace, agent };
}

function tools(workspaceDir: string, options: { writes?: boolean } = {}): ToolLike[] {
  return createAgentTools({ workspaceDir, enableWrites: options.writes === true }) as unknown as ToolLike[];
}

function tool(workspaceDir: string, name: string): ToolLike {
  const found = tools(workspaceDir).find((candidate) => candidate.name === name);
  assert.ok(found, `the server must mount a ${name} tool`);
  return found;
}

/** `write` and `edit` only exist when writes are enabled, so they are looked up that way. */
function mutatingTool(workspaceDir: string, name: string): ToolLike {
  const found = tools(workspaceDir, { writes: true }).find((candidate) => candidate.name === name);
  assert.ok(found, `${name} must be mounted when writes are enabled`);
  return found;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

/** One call against the mounted tool, normalised to the two ways a tool can refuse. */
async function attemptOn(
  target: ToolLike,
  params: unknown,
): Promise<{ refused: boolean; message: string }> {
  try {
    const result = await target.execute("call", params, undefined, undefined, undefined);
    return { refused: result.isError === true, message: textOf(result) };
  } catch (error) {
    return {
      refused: error instanceof PathEscapeError,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function attempt(
  name: string,
  workspaceDir: string,
  params: unknown,
): Promise<{ refused: boolean; message: string }> {
  return attemptOn(tool(workspaceDir, name), params);
}

async function assertRefusedOn(target: ToolLike, params: unknown, what: string): Promise<void> {
  const { refused, message } = await attemptOn(target, params);
  assert.ok(refused, `${target.name} must refuse ${what}: got ${JSON.stringify(message)}`);
  assert.match(message, /outside the workspace/, `the refusal has to say what happened: got ${JSON.stringify(message)}`);
}

async function assertRefused(name: string, workspaceDir: string, params: unknown, what: string): Promise<void> {
  return assertRefusedOn(tool(workspaceDir, name), params, what);
}

/** A call whose parameters would reach the credential if the path were not checked. */
function escapingParams(name: string, path: string): Record<string, unknown> {
  if (name === "grep") return { pattern: "syn_secret", path };
  if (name === "find") return { pattern: "*.json", path };
  return { path };
}

/** A call whose parameters are legitimate and must keep working. */
function insideParams(name: string, path?: string): Record<string, unknown> {
  const withPath = path === undefined ? {} : { path };
  if (name === "grep") return { pattern: "inside", ...withPath };
  if (name === "find") return { pattern: "*.txt", ...withPath };
  return withPath;
}

const CONFINED = ["grep", "find", "ls"] as const;

for (const name of CONFINED) {
  test(`${name} refuses an absolute path outside the workspace`, async () => {
    const { agent, workspace } = fixture();
    try {
      // grep takes a file or a directory, find and ls a directory: both shapes.
      const target = name === "grep" ? join(agent, "models.json") : agent;
      await assertRefused(name, workspace, escapingParams(name, target), "an absolute path beside the workspace");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test(`${name} refuses a path that walks out of the workspace with ..`, async () => {
    const { workspace } = fixture();
    try {
      const target = join(workspace, "..", "agent");
      await assertRefused(name, workspace, escapingParams(name, target), "traversal");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test(`${name} refuses a symlink inside the workspace that points outside it`, async () => {
    const { workspace } = fixture({ symlinks: true });
    try {
      // The name is inside the root; the real target is the credential directory.
      const target = name === "grep" ? join(workspace, "innocent.json") : join(workspace, "escape-dir");
      await assertRefused(name, workspace, escapingParams(name, target), "a symlink leaving the workspace");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test(`${name} refuses an outside path that does not exist, so the check runs before any access`, async () => {
    const { agent, workspace } = fixture();
    try {
      // Nothing to read here: the only way to answer is to refuse the path itself.
      await assertRefused(name, workspace, escapingParams(name, join(agent, "nope.json")), "a missing outside path");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test(`${name} keeps working inside the workspace`, async () => {
    const { workspace } = fixture();
    try {
      const withDefault = textOf(await tool(workspace, name).execute("call", insideParams(name), undefined, undefined, undefined));
      const withRoot = textOf(
        await tool(workspace, name).execute("call", insideParams(name, workspace), undefined, undefined, undefined),
      );

      for (const text of [withDefault, withRoot]) {
        if (name === "grep") {
          assert.match(text, /^notes\.txt:1: inside line$/m);
          assert.match(text, /^sub\/deep\.txt:1: inside deep line$/m);
        } else if (name === "find") {
          assert.match(text, /^notes\.txt$/m);
          assert.match(text, /^sub\/deep\.txt$/m);
        } else {
          assert.match(text, /^notes\.txt$/m);
          assert.match(text, /^sub\/$/m);
        }
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test(`${name} keeps working for an absolute path inside the workspace`, async () => {
    const { workspace } = fixture();
    try {
      const params =
        name === "grep"
          ? { pattern: "inside", path: join(workspace, "notes.txt") }
          : insideParams(name, workspace);
      const result = await tool(workspace, name).execute("call", params, undefined, undefined, undefined);
      assert.match(textOf(result), name === "grep" ? /^notes\.txt:1: inside line$/m : /notes\.txt/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
}

test("ls refuses a file:// URL that resolves outside the workspace", async () => {
  const { workspace } = fixture();
  try {
    // The tools expand `file://` before resolving; the check has to see the expansion.
    await assertRefused("ls", workspace, { path: "file:///etc" }, "a file:// URL outside the workspace");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("the path argument is resolved the way the coding tools resolve it", () => {
  const { workspace } = fixture();
  try {
    // A validator that skipped these expansions would allow the read it exists to stop:
    // `~/secrets` must not be treated as `<workspace>/~/secrets`.
    assert.equal(resolveRequestedPath("~/secrets", workspace), join(homedir(), "secrets"));
    assert.equal(resolveRequestedPath("~", workspace), homedir());
    assert.equal(resolveRequestedPath("file:///etc/passwd", workspace), "/etc/passwd");
    assert.equal(resolveRequestedPath("@notes.txt", workspace), join(workspace, "notes.txt"));
    assert.equal(resolveRequestedPath("sub/deep.txt", workspace), join(workspace, "sub", "deep.txt"));
    assert.equal(resolveRequestedPath(".", workspace), workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("read keeps its own confinement: same refusal outside, same answer inside", async () => {
  const { agent, workspace } = fixture();
  try {
    await assertRefused("read", workspace, { path: join(agent, "models.json") }, "the credential file");
    const result = await tool(workspace, "read").execute(
      "call",
      { path: join(workspace, "notes.txt") },
      undefined,
      undefined,
      undefined,
    );
    assert.equal(textOf(result), "inside line\n");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ write / edit */

/**
 * `write` and `edit` take the same `path` argument and had the same hole: measured
 * with `enableWrites` on, `write { path: "../agent/pwned.txt" }` answered
 * "Successfully wrote to ../agent/pwned.txt" and created the file inside the
 * directory that holds `models.json`. `AGENT_WRITES` defaults to false, which makes
 * that latent rather than live — but the flag exists so an operator can turn it on.
 *
 * A refusal is only worth anything if nothing happened, so each of these also asserts
 * the outside file was not created and the credential was not modified.
 */

/** A mutating call aimed at the directory beside the workspace. */
function escapingMutation(name: string, path: string): Record<string, unknown> {
  if (name === "write") return { path, content: "pwned\n" };
  return { path, edits: [{ oldText: "syn_secret", newText: "pwned" }] };
}

const SECRET_FILE = '{"apiKey":"syn_secret"}\n';

test("write refuses an absolute path outside the workspace and creates nothing", async () => {
  const { agent, workspace } = fixture();
  try {
    const target = join(agent, "pwned.txt");
    await assertRefusedOn(mutatingTool(workspace, "write"), escapingMutation("write", target), "an outside path");
    assert.equal(existsSync(target), false, "the refused write must not create the file");
    assert.equal(readFileSync(join(agent, "models.json"), "utf8"), SECRET_FILE);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("write refuses .. traversal and creates no parent directory outside", async () => {
  const { agent, workspace } = fixture();
  try {
    const target = join(agent, "made", "up", "pwned.txt");
    await assertRefusedOn(
      mutatingTool(workspace, "write"),
      escapingMutation("write", join(workspace, "..", "agent", "made", "up", "pwned.txt")),
      "traversal",
    );
    assert.equal(existsSync(target), false, "the refused write must not create the file");
    assert.equal(existsSync(join(agent, "made")), false, "a refused write must not create directories either");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("write refuses to write through a symlink to a file outside the workspace", async () => {
  const { agent, workspace } = fixture({ symlinks: true });
  try {
    // `innocent.json` is inside by name and points at the credential file.
    await assertRefusedOn(
      mutatingTool(workspace, "write"),
      escapingMutation("write", join(workspace, "innocent.json")),
      "a symlink leaving the workspace",
    );
    assert.equal(readFileSync(join(agent, "models.json"), "utf8"), SECRET_FILE, "the credential must be intact");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("write refuses to create a file through a directory symlink that leaves the workspace", async () => {
  const { agent, workspace } = fixture({ symlinks: true });
  try {
    // The leaf does not exist yet, so only the real directory can show the escape.
    const target = join(agent, "new.txt");
    await assertRefusedOn(
      mutatingTool(workspace, "write"),
      escapingMutation("write", join(workspace, "escape-dir", "new.txt")),
      "a directory symlink leaving the workspace",
    );
    assert.equal(existsSync(target), false, "the refused write must not land beside the workspace");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("write refuses a dangling symlink that points outside the workspace", async () => {
  const { agent, workspace } = fixture({ symlinks: true });
  try {
    // Nothing to resolve: the link's own destination is where the bytes would go.
    const target = join(agent, "nope.json");
    await assertRefusedOn(
      mutatingTool(workspace, "write"),
      escapingMutation("write", join(workspace, "dangling.json")),
      "a dangling symlink leaving the workspace",
    );
    assert.equal(existsSync(target), false, "the refused write must not create the link's target");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("write keeps creating a new file inside the workspace, parent directories included", async () => {
  const { workspace } = fixture();
  try {
    // Pin the previous behaviour: parents are created recursively before the write.
    const target = join(workspace, "fresh", "nested", "new.txt");
    const result = await mutatingTool(workspace, "write").execute(
      "call",
      { path: "fresh/nested/new.txt", content: "written inside\n" },
      undefined,
      undefined,
      undefined,
    );
    assert.match(textOf(result), /Successfully wrote to fresh\/nested\/new\.txt/);
    assert.equal(readFileSync(target, "utf8"), "written inside\n");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("write still overwrites a file inside the workspace", async () => {
  const { workspace } = fixture();
  try {
    await mutatingTool(workspace, "write").execute(
      "call",
      { path: join(workspace, "notes.txt"), content: "replaced\n" },
      undefined,
      undefined,
      undefined,
    );
    assert.equal(readFileSync(join(workspace, "notes.txt"), "utf8"), "replaced\n");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("edit refuses an absolute path outside the workspace and leaves the file byte-identical", async () => {
  const { agent, workspace } = fixture();
  try {
    const credential = join(agent, "models.json");
    const before = readFileSync(credential);
    await assertRefusedOn(
      mutatingTool(workspace, "edit"),
      escapingMutation("edit", credential),
      "an outside path",
    );
    assert.deepEqual(readFileSync(credential), before, "the refused edit must not modify the file");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("edit refuses .. traversal and leaves the file byte-identical", async () => {
  const { agent, workspace } = fixture();
  try {
    const credential = join(agent, "models.json");
    const before = readFileSync(credential);
    await assertRefusedOn(
      mutatingTool(workspace, "edit"),
      escapingMutation("edit", join(workspace, "..", "agent", "models.json")),
      "traversal",
    );
    assert.deepEqual(readFileSync(credential), before);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("edit refuses to edit through a symlink pointing outside the workspace", async () => {
  const { agent, workspace } = fixture({ symlinks: true });
  try {
    const credential = join(agent, "models.json");
    const before = readFileSync(credential);
    await assertRefusedOn(
      mutatingTool(workspace, "edit"),
      escapingMutation("edit", join(workspace, "innocent.json")),
      "a symlink leaving the workspace",
    );
    assert.deepEqual(readFileSync(credential), before, "the credential must be byte-identical");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("edit keeps working inside the workspace", async () => {
  const { workspace } = fixture();
  try {
    const result = await mutatingTool(workspace, "edit").execute(
      "call",
      { path: join(workspace, "notes.txt"), edits: [{ oldText: "inside line", newText: "edited inside" }] },
      undefined,
      undefined,
      undefined,
    );
    assert.equal(result.isError, undefined, `the edit must succeed: ${textOf(result)}`);
    assert.equal(readFileSync(join(workspace, "notes.txt"), "utf8"), "edited inside\n");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("write and edit are absent unless writes are enabled", () => {
  const { workspace } = fixture();
  try {
    const names = tools(workspace).map((candidate) => candidate.name);
    assert.deepEqual(names, ["read", "grep", "find", "ls"]);
    const enabled = tools(workspace, { writes: true }).map((candidate) => candidate.name);
    assert.deepEqual(enabled, ["read", "grep", "find", "ls", "write", "edit"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

/* --------------------------------------------- symlinked root, cycles, affordances */

/**
 * A workspace whose `WORKSPACE_DIR` is a symlink to the real tree — macOS `/tmp` and
 * `/var`, and any bind mount, look like this. The containment has to compare
 * real-to-real: resolving the target against the *textual* root refused every absolute
 * path into the real tree, and made `read` refuse everything at all.
 */
function symlinkedFixture() {
  const root = mkdtempSync(join(tmpdir(), "sandbox-link-"));
  const real = join(root, "real-workspace");
  mkdirSync(join(real, "sub"), { recursive: true });
  writeFileSync(join(real, "sub", "f.txt"), "inside sub line\n");
  const link = join(root, "workspace");
  symlinkSync(real, link, "dir");
  const agent = join(root, "agent");
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, "models.json"), SECRET_FILE);
  return { root, real, link, agent };
}

/** Every confined tool refuses with the shared vocabulary, and the decoy is untouched. */
async function assertRefusedEverywhere(
  workspaceDir: string,
  decoyFile: string,
  path: string,
  what: string,
): Promise<void> {
  const decoy = readFileSync(decoyFile);
  for (const name of ALL_TOOLS) {
    await assertRefusedOn(confinedTool(workspaceDir, name), escapeAttempt(name, path), `${what} (${name})`);
  }
  assert.deepEqual(readFileSync(decoyFile), decoy, "the decoy must be byte-identical afterwards");
}

const ALL_TOOLS = ["read", "grep", "find", "ls", "write", "edit"] as const;

/** The tool as mounted: `write` and `edit` only exist with writes enabled. */
function confinedTool(workspaceDir: string, name: string): ToolLike {
  return name === "write" || name === "edit" ? mutatingTool(workspaceDir, name) : tool(workspaceDir, name);
}

/** The parameters that would reach the decoy if the path argument were not checked. */
function escapeAttempt(name: string, path: string): Record<string, unknown> {
  switch (name) {
    case "grep":
      return { pattern: "syn_secret", path };
    case "find":
      return { pattern: "*.json", path };
    case "write":
      return { path, content: "pwned\n" };
    case "edit":
      return { path, edits: [{ oldText: "syn_secret", newText: "pwned" }] };
    default:
      return { path };
  }
}

test("a workspace mounted through a symlink stays usable: relative and absolute paths", async () => {
  const { root, real, link } = symlinkedFixture();
  try {
    const call = (name: string, params: unknown) =>
      confinedTool(link, name).execute("call", params, undefined, undefined, undefined);

    // `read` has to survive a symlinked root too, or the agent cannot open anything.
    for (const target of ["sub/f.txt", join(link, "sub/f.txt"), join(real, "sub/f.txt")]) {
      assert.equal(textOf(await call("read", { path: target })), "inside sub line\n", `read must open ${target}`);
    }

    // Relative, absolute through the link, and absolute into the real tree.
    for (const target of ["sub", join(link, "sub"), join(real, "sub")]) {
      assert.match(
        textOf(await call("grep", { pattern: "inside", path: target })),
        /^f\.txt:1: inside sub line$/m,
        `grep must reach ${target}`,
      );
      assert.match(textOf(await call("find", { pattern: "*.txt", path: target })), /^f\.txt$/m, `find must reach ${target}`);
    }
    assert.match(textOf(await call("ls", { path: real })), /^sub\/$/m, "ls must list the real tree");
    assert.match(textOf(await call("ls", { path: link })), /^sub\/$/m, "ls must list the declared root");

    // And a write into the real tree is a write inside the workspace.
    const written = join(real, "sub", "new.txt");
    await call("write", { path: join(real, "sub", "new.txt"), content: "written inside\n" });
    assert.equal(readFileSync(written, "utf8"), "written inside\n");

    // `edit` resolves the same way: the target is reached through the real tree.
    await call("edit", { path: join(real, "sub", "new.txt"), edits: [{ oldText: "written", newText: "edited" }] });
    assert.equal(readFileSync(written, "utf8"), "edited inside\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a path outside the workspace is still refused when the root is a symlink", async () => {
  const { root, link, agent } = symlinkedFixture();
  try {
    // The sibling holding the credential is outside the declared root and stays outside
    // the real tree; resolving the root must not widen the boundary.
    await assertRefusedEverywhere(
      link,
      join(agent, "models.json"),
      join(link, "..", "agent", "models.json"),
      "the credential beside a symlinked root",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symlink cycle is refused, not passed through to the tool", async () => {
  const { agent, workspace } = fixture();
  try {
    // Nothing resolves here: before the fix the check returned "unknown" and the tool
    // ran, surfacing a raw ELOOP (or "Path not found") instead of the refusal.
    symlinkSync(join(workspace, "loopB"), join(workspace, "loopA"));
    symlinkSync(join(workspace, "loopA"), join(workspace, "loopB"));
    await assertRefusedEverywhere(workspace, join(agent, "models.json"), join(workspace, "loopA"), "an unresolvable symlink cycle");
    assert.deepEqual(readdirSync(agent).sort(), ["models.json"], "the refused calls must leave the sibling untouched");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a symlink cycle below the path is refused too", async () => {
  const { workspace } = fixture();
  try {
    symlinkSync(join(workspace, "loopB"), join(workspace, "loopA"));
    symlinkSync(join(workspace, "loopA"), join(workspace, "loopB"));
    // The cycle is not the leaf: the leaf would be created through it.
    await assertRefusedOn(mutatingTool(workspace, "write"), escapeAttempt("write", join(workspace, "loopA", "x.txt")), "a cycle above the leaf");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("~, @ and file:// escapes out of the workspace are refused with the decoy intact", async () => {
  const { agent, workspace } = fixture();
  const previousHome = process.env.HOME;
  // `~` must expand to the decoy directory, not to the real HOME of whoever runs this.
  process.env.HOME = agent;
  try {
    const decoy = join(agent, "models.json");
    for (const attempt of ["~/models.json", "@../agent/models.json", `file://${decoy}`]) {
      const before = readFileSync(decoy);
      for (const name of ALL_TOOLS) {
        await assertRefusedOn(confinedTool(workspace, name), escapeAttempt(name, attempt), `${attempt} (${name})`);
      }
      assert.deepEqual(readFileSync(decoy), before, `${attempt} must leave the decoy byte-identical`);
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a caller-supplied ctx.cwd cannot redirect a tool outside the workspace", async () => {
  const { agent, workspace } = fixture();
  try {
    writeFileSync(join(agent, "outside-only.txt"), "OUTSIDE TOP-SECRET\n");
    // The wrapper forwards the documented arguments only, so a second base directory
    // never reaches the SDK tool's own path resolution.
    const result = await tool(workspace, "grep").execute(
      "call",
      { pattern: "TOP-SECRET", path: "." },
      undefined,
      undefined,
      { cwd: agent },
    );
    assert.equal(textOf(result), "No matches found", "ctx.cwd must not become a second workspace");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

/* -------------------------------------------- the three probes that survived review */

/**
 * Three properties a reviewer re-measured on the real-to-real fix, kept here so a
 * regression fails a test instead of needing another review: a symlinked root must reach
 * exactly the content a real root reaches, for every tool; it must still refuse every
 * escape shape a real root refuses; and a root that cannot be resolved at all must refuse
 * every call, including the innocent ones, because an unjudgeable request is not
 * permission.
 */

test("a symlinked root reaches the same content a real root reaches, for every tool", async () => {
  const { root, real, link } = symlinkedFixture();
  try {
    const call = (workspaceDir: string, name: string, params: unknown) =>
      confinedTool(workspaceDir, name).execute("call", params, undefined, undefined, undefined);

    // The reading tools answer byte-identical text; asserting it is non-empty keeps the
    // comparison from passing vacuously on two empty answers.
    const reading: Array<[string, Record<string, unknown>]> = [
      ["read", { path: "sub/f.txt" }],
      ["grep", { pattern: "inside", path: "sub" }],
      ["find", { pattern: "*.txt", path: "sub" }],
      ["ls", { path: "sub" }],
    ];
    for (const [name, params] of reading) {
      const viaReal = await call(real, name, params);
      const viaLink = await call(link, name, params);
      assert.equal(viaReal.isError, undefined, `${name} must answer through the real root: ${textOf(viaReal)}`);
      assert.equal(viaLink.isError, undefined, `${name} must answer through the symlinked root: ${textOf(viaLink)}`);
      assert.notEqual(textOf(viaReal), "", `${name} must have answered something, or the comparison is vacuous`);
      assert.equal(textOf(viaLink), textOf(viaReal), `${name} must answer the same text through either root`);
    }

    // The mutating tools land on the same bytes and report the same words. The target is
    // the real tree addressed absolutely, so only a real-to-real comparison accepts it.
    const target = join(real, "sub", "probe.txt");
    const write = { path: target, content: "written through either root\n" };
    const writeReal = await call(real, "write", write);
    const writtenBytes = readFileSync(target, "utf8");
    const writeLink = await call(link, "write", write);
    assert.equal(writeReal.isError, undefined, `write must succeed through the real root: ${textOf(writeReal)}`);
    assert.equal(writeLink.isError, undefined, `write must succeed through the symlinked root: ${textOf(writeLink)}`);
    assert.equal(writtenBytes, "written through either root\n");
    assert.equal(textOf(writeLink), textOf(writeReal), "write must report the same words through either root");
    assert.equal(readFileSync(target, "utf8"), writtenBytes, "write must land on the same bytes through either root");

    const edit = { path: target, edits: [{ oldText: "through either root", newText: "via both roots" }] };
    const editReal = await call(real, "edit", edit);
    const editedBytes = readFileSync(target, "utf8");
    // Same starting content for the second run, so the two edits are the same request.
    writeFileSync(target, "written through either root\n");
    const editLink = await call(link, "edit", edit);
    assert.equal(editReal.isError, undefined, `edit must succeed through the real root: ${textOf(editReal)}`);
    assert.equal(editLink.isError, undefined, `edit must succeed through the symlinked root: ${textOf(editLink)}`);
    assert.equal(editedBytes, "written via both roots\n");
    assert.equal(textOf(editLink), textOf(editReal), "edit must report the same words through either root");
    assert.equal(readFileSync(target, "utf8"), editedBytes, "edit must land on the same bytes through either root");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symlinked root refuses every escape shape for all six tools", async () => {
  const { root, real, link, agent } = symlinkedFixture();
  const previousHome = process.env.HOME;
  try {
    // Names inside the real tree that land outside it: resolving the root must not launder
    // them, because the comparison is on where the request lands and these land in `agent`.
    symlinkSync(join(agent, "models.json"), join(real, "out-link.json"));
    symlinkSync(agent, join(real, "out-dir"), "dir");
    symlinkSync(join(agent, "nowhere.json"), join(real, "dangle.json"));
    // `~` has to expand to the decoy directory, not to the runner's real HOME.
    process.env.HOME = agent;

    const decoy = join(agent, "models.json");
    const shapes: Array<[string, string]> = [
      ["an absolute path beside the root", decoy],
      ["a `..` traversal out of the declared root", join(link, "..", "agent", "models.json")],
      ["the sibling directory itself", agent],
      ["a symlink inside the real tree pointing out", join(real, "out-link.json")],
      ["a directory symlink inside the real tree", join(real, "out-dir")],
      ["a dangling symlink inside the real tree", join(real, "dangle.json")],
      ["an outside path that does not exist", join(agent, "nope.json")],
      ["`~` expansion", "~/models.json"],
      ["an `@`-prefixed traversal", "@../agent/models.json"],
      ["a file:// URL", `file://${decoy}`],
    ];
    for (const [what, path] of shapes) {
      await assertRefusedEverywhere(link, decoy, path, what);
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a root that cannot be resolved refuses every call, including the innocent ones", async () => {
  const { root, agent } = symlinkedFixture();
  try {
    // The root itself is the cycle, so nothing below it resolves either: every request is
    // unjudgeable, and unjudgeable is refused rather than allowed.
    const rootLink = join(root, "cycle-a");
    symlinkSync(join(root, "cycle-b"), rootLink);
    symlinkSync(rootLink, join(root, "cycle-b"));

    const decoy = join(agent, "models.json");
    for (const path of [".", "sub/f.txt", join(rootLink, "sub/f.txt")]) {
      await assertRefusedEverywhere(rootLink, decoy, path, `a call through a root that cannot be resolved (${path})`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
