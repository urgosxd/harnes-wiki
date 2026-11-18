import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TSchema } from "typebox";
import { createAgentTools } from "../src/pi/agent-tools.ts";
import { parseAgentDefinition, unsupportedKeysFor, loadAgentDefinitions } from "../src/pi/agents.ts";
import { PathEscapeError } from "../src/pi/sandbox.ts";

/**
 * Skills are reachable only because they are mounted INSIDE the workspace.
 *
 * Pi writes each skill's absolute `<location>` into the system prompt and tells the
 * model to open it with `read`. That `read` is confined to the workspace
 * (`src/pi/sandbox.ts`), so a skill discovered from the user scope
 * (`$HOME/.agents/skills`) is described to the model and then cannot be opened:
 * measured, the read fails with `PathEscapeError: ... is outside the workspace`.
 *
 * The fix is placement, not a wider sandbox: the compose files mount `server/skills`
 * at `<PI_WORKSPACE_DIR>/.pi/skills`, which is where Pi discovers project skills, so
 * the existing confined `read` reaches them. These tests pin the two halves of that
 * claim against the real tool instances this server builds: the body is readable from
 * inside the workspace, and the same tool still refuses the identical file one
 * directory above it.
 *
 * No source change accompanies this: the change is in `docker-compose*.yml` and
 * `server/Dockerfile`, which no unit test can execute. What is asserted here is the
 * mechanism the mounts rely on.
 */

/** The mounted file, as Pi would present it: a directory holding a `SKILL.md`. */
const SKILL_BODY = `# Wiki agentic search

You answer questions over a compiled wiki by choosing tools in a loop.
`;

const SKILL_FILE = "---\nname: llm-wiki-mcp\ndescription: Wiki host tools.\n---\n\n" + SKILL_BODY;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "skills-volume-"));
  // The workspace is the session `cwd`; the sibling is the container's $HOME, which
  // is where the user-scope skill would live when it is not mounted into the workspace.
  const workspace = join(root, "workspace");
  const home = join(root, "home-node");
  mkdirSync(join(workspace, ".pi", "skills", "llm-wiki-mcp"), { recursive: true });
  mkdirSync(join(home, ".agents", "skills", "llm-wiki-mcp"), { recursive: true });
  writeFileSync(join(workspace, ".pi", "skills", "llm-wiki-mcp", "SKILL.md"), SKILL_FILE);
  writeFileSync(join(home, ".agents", "skills", "llm-wiki-mcp", "SKILL.md"), SKILL_FILE);
  return { root, workspace, home };
}

type ToolLike = {
  name: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
};

/** The `read` tool exactly as the server mounts it, built by the server's own factory. */
function readTool(workspaceDir: string): ToolLike {
  const tools = createAgentTools({ workspaceDir }) as unknown as ToolLike[];
  const read = tools.find((tool) => tool.name === "read");
  assert.ok(read, "the server must mount a read tool for skills to be reachable at all");
  return read;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

test("a skill mounted at <cwd>/.pi/skills is readable with the confined read tool", async () => {
  const { workspace } = fixture();
  try {
    // The absolute path is what the system prompt puts in front of the model.
    const location = join(workspace, ".pi", "skills", "llm-wiki-mcp", "SKILL.md");
    const result = await readTool(workspace).execute("call-1", { path: location }, undefined, undefined, undefined);

    const text = textOf(result);
    assert.match(
      text,
      /You answer questions over a compiled wiki by choosing tools in a loop\./,
      "the skill BODY must reach the model, not only its name and description",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("the same read still refuses that skill when it is mounted outside the workspace", async () => {
  const { workspace, home } = fixture();
  try {
    // The old placement: user scope, $HOME/.agents/skills. It is discovered and then
    // unreadable, which is the measured failure this feature exists to remove — the
    // refusal is what has to stay, the placement is what moved.
    const location = join(home, ".agents", "skills", "llm-wiki-mcp", "SKILL.md");
    await assert.rejects(
      readTool(workspace).execute("call-2", { path: location }, undefined, undefined, undefined),
      (error: unknown) => {
        assert.ok(error instanceof PathEscapeError, `expected PathEscapeError, got ${String(error)}`);
        assert.match((error as Error).message, /outside the workspace/);
        return true;
      },
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a relative path into .pi/skills works from the workspace too", async () => {
  const { workspace } = fixture();
  try {
    // `read` resolves a relative path against the session cwd, which is the workspace.
    const result = await readTool(workspace).execute(
      "call-3",
      { path: ".pi/skills/llm-wiki-mcp/SKILL.md" },
      undefined,
      undefined,
      undefined,
    );
    assert.match(textOf(result), /^---\nname: llm-wiki-mcp/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

/**
 * The role this repository ships for the wiki search agent must be a definition this
 * runtime can actually apply. A selected definition carrying `model`, `thinking` or
 * `tools` fails the boot (`src/main.ts`), and a YAML block list fails the parse for
 * every file in the directory — so the shipped copy is checked here, not by hand.
 *
 * These last two tests read a repository file, so they resolve the root through
 * `CI_REPO_ROOT` exactly as the rest of the suite does. `server/agents` is NOT copied
 * into the test image (`server/Dockerfile` copies `src`, `scripts` and `tsconfig.json`
 * only), so resolving it relative to this file would look for `/app/agents` there and
 * fail on a checkout that exists — the mount at `CI_REPO_ROOT` is what points these
 * assertions at the agents directory in CI.
 */
const REPO_ROOT =
  process.env.CI_REPO_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AGENTS_DIR = join(REPO_ROOT, "server", "agents");
const inCheckout = existsSync(AGENTS_DIR);
const skip = inCheckout
  ? false
  : "needs the repository checkout (the test image mounts it at CI_REPO_ROOT)";

test("the wiki role is a definition this runtime can apply", { skip }, () => {
  const source = readFileSync(join(AGENTS_DIR, "wiki-agentic-search.md"), "utf8");
  const { definition, unsupportedKeys } = parseAgentDefinition(source, "wiki-agentic-search.md");

  assert.equal(definition.name, "wiki-agentic-search");
  assert.deepEqual(
    unsupportedKeys,
    [],
    "the file must carry only name and description: model, thinking and tools fail the boot",
  );
  // The frontmatter is exactly the two supported keys — no block list, no extras.
  const frontmatter = source.split(/\r?\n/).slice(1, source.split(/\r?\n/).indexOf("---", 1));
  assert.deepEqual(
    frontmatter.map((line) => line.slice(0, line.indexOf(":")).trim()),
    ["name", "description"],
  );
  assert.match(definition.description, /Agentic search over the wiki/);
  assert.match(definition.body, /^# Wiki agentic search/);
});

test("every definition the repository ships loads, and none of them carries ignored keys", { skip }, () => {
  const loaded = loadAgentDefinitions(AGENTS_DIR);

  assert.ok(loaded.definitions.has("wiki-agentic-search"));
  assert.ok(loaded.definitions.has("documentor"));
  assert.deepEqual(
    loaded.unsupported,
    [],
    "a shipped definition carrying model/thinking/tools would fail the boot when selected",
  );
  assert.deepEqual(unsupportedKeysFor(loaded, "wiki-agentic-search"), []);
});
