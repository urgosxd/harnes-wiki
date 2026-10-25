import { copyFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Prepare a writable copy of the Pi agent directory's credentials.
 *
 * Pi's credential store takes a lock file beside `auth.json` and creates the file
 * when it is missing, so it must be able to write. A read-only mount (the right way
 * to ship credentials into a container) therefore fails at startup with
 * `EROFS: read-only file system, mkdir '<agentDir>/auth.json.lock'`.
 *
 * Copying the two config files into a writable location keeps the source mount
 * read-only while giving Pi what it needs:
 *
 *  - `models.json` may hold provider credentials, so the copy is made with mode
 *    0600 rather than the source's permissions.
 *  - Nothing else from the agent directory is copied. Extensions, skills and
 *    AGENTS.md are development resources the product must never load.
 *
 * @returns The directory the runtime should use as its agent dir.
 */
export async function prepareWritableAgentDir(options: {
  sourceDir: string;
  runtimeDir: string;
}): Promise<string> {
  const { sourceDir, runtimeDir } = options;
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });

  const copied: string[] = [];
  for (const name of ["models.json", "auth.json"]) {
    const from = join(sourceDir, name);
    const to = join(runtimeDir, name);
    try {
      const info = await stat(from);
      if (!info.isFile()) continue;
      // 0600: the destination carries credentials.
      await copyFile(from, to);
      const { chmod } = await import("node:fs/promises");
      await chmod(to, 0o600);
      copied.push(name);
    } catch (error) {
      // A missing auth.json is normal for API-key-only setups; anything else is not.
      if (isMissing(error)) continue;
      throw error;
    }
  }

  if (!copied.includes("models.json") && !copied.includes("auth.json")) {
    throw new Error(
      `no credentials found in ${sourceDir}: expected models.json or auth.json. ` +
        "Provider credentials must be present for any turn to succeed.",
    );
  }

  return runtimeDir;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}
