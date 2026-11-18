import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The Pi agent directory this machine uses for provider credentials. */
export const AGENT_DIR = process.env.PI_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");

export const PROVIDER = process.env.CHAT_PROVIDER ?? "synthetic";
export const MODEL_ID = process.env.CHAT_MODEL ?? "syn:large:text";

/** True when this machine can reach a model at all. Used to skip live tests, never
 *  to silently pass them: a skipped live test is reported as skipped.
 *
 *  The rule, in one sentence: a credential file counts only when it CONTAINS something —
 *  absent, zero-length, whitespace-only or `{}` mean "no credentials here" — because
 *  `AuthStorage`'s constructor writes `{}` into whatever agent directory it is handed,
 *  and existence alone made an empty directory look like a machine with credentials to
 *  every test process that started after that write. Content that is present but is not
 *  JSON at all counts as configured: a broken credential file must fail the live tier
 *  loudly, not let it skip. */
export function hasCredentials(agentDir: string = AGENT_DIR): boolean {
  return (
    fileHasCredentialContent(join(agentDir, "models.json")) ||
    fileHasCredentialContent(join(agentDir, "auth.json"))
  );
}

function fileHasCredentialContent(path: string): boolean {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    // Absent is the honest "no credentials". Anything else unreadable cannot be proven
    // empty, so it stays configured rather than turning into a silent skip.
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : true;
  }
  const trimmed = content.replace(/^\uFEFF/, "").trim();
  if (trimmed === "") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return true;
  }
  if (typeof parsed !== "object" || parsed === null) return true;
  return Object.keys(parsed).length > 0;
}

/** A throwaway neutral workspace, so no test ever points Pi at a real project. */
export function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "agentdoc-ws-"));
}
