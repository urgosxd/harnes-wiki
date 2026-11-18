import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { assertPathInsideRoot, PathEscapeError, confinedReadOperations } from "./sandbox.ts";

/**
 * Which coding tools a chat session may use.
 *
 * The product hides development tooling from the *interface*: no file browser, no
 * terminal, no settings. That is a UI decision and it stays. What the model needs
 * is different - a support assistant has to read a document, and a shell is how it
 * inspects a repository - so tools are available to the model while remaining
 * invisible to the user.
 *
 * `bash` is the exception and is OFF by default. Letting `read` out of the
 * workspace took a path-confinement fix; a shell cannot be confined that way,
 * because it can reach anything the process can. Measured: with `bash` enabled the
 * model read its own provider key with a single `cat`. Turning it on is therefore
 * an explicit decision per deployment, not a default.
 */
export interface AgentToolOptions {
  workspaceDir: string;
  /** Enable the shell. Default false; see the warning above. */
  enableBash?: boolean;
  /** Enable write/edit. Default false. */
  enableWrites?: boolean;
}

const READ_ONLY = ["read", "grep", "find", "ls"] as const;

/**
 * Confine a coding tool that takes its target as a `path` argument.
 *
 * `read` is confined from the inside, by `confinedReadOperations`. The others are
 * not: `grep`, `find`, `ls`, `write` and `edit` take a `path` argument (grep: pattern
 * + path, find: glob + path, the rest: path alone) and hand it to ripgrep, fd,
 * `readdir` or `fs.writeFile`. Measured with the tools as they were mounted here,
 * `ls ../agent` listed the directory holding the provider credential, `grep
 * ../agent/models.json` printed it, and `write ../agent/pwned.txt` created a file in
 * it.
 *
 * Their operations seam cannot carry this: `find` swaps fd for a custom `glob()` the
 * moment one is supplied, and grep rewrites a thrown `isDirectory()` into
 * "Path not found". So the argument is checked here, before the tool runs at all, and
 * refused with `PathEscapeError` — the same words `read` refuses with, before any
 * filesystem access, with no cooperation needed from the model.
 */
function confinePathArgument(
  tool: AgentTool<TSchema, unknown>,
  root: string,
): AgentTool<TSchema, unknown> {
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const requested = (params as { path?: unknown } | undefined)?.path;
      if (requested !== undefined && typeof requested !== "string") {
        // Only a string can be shown to be inside; fail closed without touching the disk.
        throw new PathEscapeError(JSON.stringify(requested), root);
      }
      await assertPathInsideRoot(requested ?? ".", root);
      return tool.execute(toolCallId, params, signal, onUpdate);
    },
  };
}

/** The tool instances a session should mount, already confined to the workspace. */
export function createAgentTools(options: AgentToolOptions): AgentTool<TSchema, unknown>[] {
  const { workspaceDir, enableBash = false, enableWrites = false } = options;

  // The tools are a heterogeneous list: each has its own parameter schema, so the
  // array is typed by the widest shape rather than by any single tool.
  const tools: AgentTool<TSchema, unknown>[] = [
    // `read` gets confined operations: it refuses anything outside the workspace.
    createReadTool(workspaceDir, { operations: confinedReadOperations(workspaceDir) }) as AgentTool<TSchema, unknown>,
    // The rest take a path argument, so they are confined at the argument instead.
    confinePathArgument(createGrepTool(workspaceDir) as AgentTool<TSchema, unknown>, workspaceDir),
    confinePathArgument(createFindTool(workspaceDir) as AgentTool<TSchema, unknown>, workspaceDir),
    confinePathArgument(createLsTool(workspaceDir) as AgentTool<TSchema, unknown>, workspaceDir),
  ];

  if (enableBash) {
    tools.push(createBashTool(workspaceDir) as AgentTool<TSchema, unknown>);
  }
  if (enableWrites) {
    tools.push(
      // Writes take the same `path` argument, so they are confined the same way: the
      // leaf of a write may not exist yet, which is why the check resolves the real
      // directory it would be created in (see `assertPathInsideRoot`).
      confinePathArgument(createWriteTool(workspaceDir) as AgentTool<TSchema, unknown>, workspaceDir),
      confinePathArgument(createEditTool(workspaceDir) as AgentTool<TSchema, unknown>, workspaceDir),
    );
  }

  return tools;
}

/** Tool names matching `createAgentTools`, for the session's allowlist. */
export function agentToolNames(options: AgentToolOptions): string[] {
  const names: string[] = [...READ_ONLY];
  if (options.enableBash) names.push("bash");
  if (options.enableWrites) names.push("write", "edit");
  return names;
}
