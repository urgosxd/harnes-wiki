import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The Pi agent directory this machine uses for provider credentials. */
export const AGENT_DIR = process.env.PI_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");

export const PROVIDER = process.env.CHAT_PROVIDER ?? "synthetic";
export const MODEL_ID = process.env.CHAT_MODEL ?? "syn:large:text";

/** True when this machine can reach a model at all. Used to skip live tests, never
 *  to silently pass them: a skipped live test is reported as skipped. */
export function hasCredentials(): boolean {
  return existsSync(join(AGENT_DIR, "models.json")) || existsSync(join(AGENT_DIR, "auth.json"));
}

/** A throwaway neutral workspace, so no test ever points Pi at a real project. */
export function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "agentdoc-ws-"));
}
