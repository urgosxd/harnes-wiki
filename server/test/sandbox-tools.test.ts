import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
