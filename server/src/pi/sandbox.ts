import { readFile, access, lstat, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
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
 * Two properties the rules above need spelled out:
 *  - Every comparison is real-to-real: the root is resolved at check time, on every
 *    assertion, with no caching, because `WORKSPACE_DIR` is often a symlink itself
 *    (macOS `/tmp`, `/var`, a mount) and a textual comparison then refuses the real tree
 *    it points at.
 *  - The check is fail-closed: a landing that cannot be resolved at all — a symlink
 *    cycle, a chain longer than the hop budget — is refused, not waved through.
 *
 * What this is not: the check and the tool's own syscall are separate awaits, so a
 * process able to swap a link in between can still move the landing. Closing that
 * window needs `openat`-style resolution the SDK tools do not expose; this is a
 * boundary against the model's arguments, not against a concurrent writer that
 * already has filesystem access.
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
 * The target and the root are both resolved to their real location, so a symlink
 * pointing outward is rejected on where it lands and a workspace that is itself a
 * symlink stays readable. A landing nobody can resolve is refused.
 */
export function confinedReadOperations(root: string): ReadOperations {
  async function assertInside(absolutePath: string): Promise<void> {
    const resolved = resolve(absolutePath);
    const landing = await realLandingPath(resolved);
    if (landing === undefined) throw new PathEscapeError(resolved, root);
    if (!isInsideRoot(landing, await resolveRealRoot(root))) {
      throw new PathEscapeError(landing, root);
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

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Resolve a tool's `path` argument exactly the way the coding tools do.
 *
 * `grep`, `find` and `ls` resolve their `path` with the SDK's `resolveToCwd()`, which
 * expands `~`, strips a leading `@`, unifies unicode spaces and accepts `file://`
 * URLs. That helper is not exported by the package, so the escape hatches it honours
 * are repeated here rather than ignored: a check that read `~/secrets` as
 * `<workspace>/~/secrets` would allow the read it sits there to stop.
 */
export function resolveRequestedPath(requested: string, root: string): string {
  let normalized = requested.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") return homedir();
  if (normalized.startsWith("~/")) return join(homedir(), normalized.slice(2));
  if (normalized.startsWith("file://")) {
    try {
      return fileURLToPath(normalized);
    } catch {
      // A file URL that cannot be parsed cannot be shown to be inside either.
      throw new PathEscapeError(normalized, root);
    }
  }
  // An absolute path stays absolute: `resolve` returns it unchanged.
  return resolve(root, normalized);
}

/**
 * The check for the tools that take a `path` argument instead of read operations.
 *
 * `grep`, `find` and `ls` are handed their path by the model and pass it straight to
 * ripgrep, fd or `readdir`. Measured on the committed tree: `ls ../agent` listed the
 * directory holding the provider credential and `grep ../agent/models.json` printed
 * it. `write` and `edit` were worse: they created or rewrote the file.
 *
 * This resolves the request the same way those tools do, then refuses it with the
 * vocabulary `read` already uses, before the tool touches the filesystem.
 *
 * Containment is decided real-to-real: the request's landing and the root are both
 * resolved, so a symlinked `WORKSPACE_DIR` accepts absolute paths into the tree it
 * points at while a sibling of that tree stays outside. An unresolvable landing — a
 * symlink cycle, an exhausted hop budget — is refused rather than treated as unknown.
 */
export async function assertPathInsideRoot(requested: string, root: string): Promise<void> {
  const resolved = resolveRequestedPath(requested, root);
  const landing = await realLandingPath(resolved);
  if (landing === undefined) throw new PathEscapeError(resolved, root);
  if (!isInsideRoot(landing, await resolveRealRoot(root))) {
    throw new PathEscapeError(landing, root);
  }
}

/** The real location of the workspace root, or its textual one when it cannot be resolved. */
async function resolveRealRoot(root: string): Promise<string> {
  return (await realLandingPath(resolve(root))) ?? resolve(root);
}

/**
 * Where a request really lands on disk, including a file that does not exist yet.
 *
 * `realpath` is enough for a read: a missing file cannot leak anything. A write can
 * create it, so it is not enough here — measured on the committed tree, `write` to
 * `escape-dir/new.txt` (a directory symlink pointing at the credential directory) and
 * to `dangling.json` (a symlink to a file that does not exist) both created the file
 * outside the workspace, and neither leaf exists for `realpath` to follow.
 *
 * So the deepest existing prefix is resolved for real, the not-yet-existing tail is
 * appended to it, and a symlink whose target does not exist is followed by reading the
 * link itself. `undefined` means the landing could not be resolved at all — a link
 * cycle, or a chain longer than the hop budget. The two call sites that judge a request,
 * `assertInside` in `confinedReadOperations` and `assertPathInsideRoot`, refuse an
 * `undefined` landing instead of reading it as permission. The one place that does not
 * refuse is `resolveRealRoot`, which falls back to the textual root when the root itself
 * cannot be resolved: that cannot widen access, because a root nobody can resolve makes
 * every lexical descendant unresolvable too, so those requests are refused on their own
 * landing before any comparison happens.
 */
async function realLandingPath(absolutePath: string): Promise<string | undefined> {
  const missing: string[] = [];
  let probe = absolutePath;

  for (let hop = 0; hop < 32; hop += 1) {
    const real = await realpath(probe).catch(() => undefined);
    if (real !== undefined) {
      // `missing` is collected deepest-first; join wants it shallowest-first.
      return join(real, ...missing.slice().reverse());
    }

    const link = await lstat(probe)
      .then((stats) => (stats.isSymbolicLink() ? readlink(probe) : undefined))
      .catch(() => undefined);
    if (link !== undefined) {
      // A link that resolves to nothing: its target is the path to judge instead.
      probe = resolve(dirname(probe), link);
      continue;
    }

    const parent = dirname(probe);
    if (parent === probe) return undefined;
    missing.push(basename(probe));
    probe = parent;
  }

  return undefined;
}
