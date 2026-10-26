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
import { confinedReadOperations } from "./sandbox.ts";

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

/** The tool instances a session should mount, already confined to the workspace. */
export function createAgentTools(options: AgentToolOptions): AgentTool<TSchema, unknown>[] {
  const { workspaceDir, enableBash = false, enableWrites = false } = options;

  // The tools are a heterogeneous list: each has its own parameter schema, so the
  // array is typed by the widest shape rather than by any single tool.
  const tools: AgentTool<TSchema, unknown>[] = [
    // `read` gets confined operations: it refuses anything outside the workspace.
    createReadTool(workspaceDir, { operations: confinedReadOperations(workspaceDir) }) as AgentTool<TSchema, unknown>,
    createGrepTool(workspaceDir) as AgentTool<TSchema, unknown>,
    createFindTool(workspaceDir) as AgentTool<TSchema, unknown>,
    createLsTool(workspaceDir) as AgentTool<TSchema, unknown>,
  ];

  if (enableBash) {
    tools.push(createBashTool(workspaceDir) as AgentTool<TSchema, unknown>);
  }
  if (enableWrites) {
    tools.push(
      createWriteTool(workspaceDir) as AgentTool<TSchema, unknown>,
      createEditTool(workspaceDir) as AgentTool<TSchema, unknown>,
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
