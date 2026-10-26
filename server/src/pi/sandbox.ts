import { readFile, access, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { ReadOperations } from "@earendil-works/pi-coding-agent";

/**
 * Confine the agent's file access to one directory tree.
 *
 * This exists because of a measured leak, not a hypothetical one. With the `read`
 * tool enabled and credentials inside the container, asking the model to read
 * `/data/workspace/agent/models.json` returned the provider API key verbatim; the
 * `bash` tool did the same with a single `cat`. The generated config has to live
 * somewhere the process can read, so the containment has to be in the tools.
 *
 * Two rules:
 *  - A path is resolved first, so `../../agent/models.json` cannot escape by
 *    walking up and symlinks are followed before the check.
 *  - A request that leaves the root is refused with an error the model can read,
 *    rather than silently returning an empty file.
 *
 * This is a real boundary for file reads. It is NOT a sandbox for `bash`: a shell
 * can reach anything the process can, so shell access is a separate decision
 * (see `agent-tools.ts`).
 */
export class PathEscapeError extends Error {
  constructor(requested: string, root: string) {
    super(
      `refused: ${requested} is outside the workspace (${root}). ` +
        "Only files inside the workspace are readable.",
    );
    this.name = "PathEscapeError";
  }
}

export function isInsideRoot(absolutePath: string, root: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(absolutePath);
  if (normalizedPath === normalizedRoot) return true;
  return normalizedPath.startsWith(normalizedRoot + sep);
}

/**
 * Read operations that refuse anything outside `root`.
 *
 * `realpath` is applied to an existing target so a symlink pointing outward is
 * rejected on its real location, not its name.
 */
export function confinedReadOperations(root: string): ReadOperations {
  async function assertInside(absolutePath: string): Promise<void> {
    const resolved = resolve(absolutePath);
    if (!isInsideRoot(resolved, root)) throw new PathEscapeError(resolved, root);

    // A symlink can point outside the root while its name looks contained.
    const real = await realpath(resolved).catch(() => undefined);
    if (real !== undefined && !isInsideRoot(real, root)) {
      throw new PathEscapeError(real, root);
    }
  }

  return {
    access: async (absolutePath: string) => {
      await assertInside(absolutePath);
      await access(absolutePath);
    },
    readFile: async (absolutePath: string) => {
      await assertInside(absolutePath);
      return readFile(absolutePath);
    },
  };
}
