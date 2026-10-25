import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../src/db/pool.ts";

export const AGENT_DIR = process.env.PI_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");
export const PROVIDER = process.env.CHAT_PROVIDER ?? "synthetic";
export const MODEL_ID = process.env.CHAT_MODEL ?? "syn:large:text";
export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://agentdocumentor:agentdocumentor@127.0.0.1:5432/agentdocumentor";

export function hasCredentials(): boolean {
  return existsSync(join(AGENT_DIR, "models.json")) || existsSync(join(AGENT_DIR, "auth.json"));
}

/** Synchronous on purpose: `before()` in node:test cannot skip, so availability is
 *  decided at module load and passed to each test as its `skip` option. */
export function databaseReady(): boolean {
  try {
    const status = execFileSync(
      "docker",
      ["inspect", "--format", "{{.State.Health.Status}}", "agentdoc-postgres"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return status === "healthy";
  } catch {
    return false;
  }
}

export function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "agentdoc-ws-"));
}

let counter = 0;
export function testUser(label = "user"): string {
  counter += 1;
  return `test-${label}-${randomUUID().slice(0, 8)}-${counter}`;
}

export async function openDatabase() {
  return createDatabase(DATABASE_URL);
}
