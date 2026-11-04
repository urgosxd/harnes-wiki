import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../src/db/pool.ts";
import { databaseAvailable } from "./db.ts";

export const AGENT_DIR = process.env.PI_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");
export const PROVIDER = process.env.CHAT_PROVIDER ?? "synthetic";
export const MODEL_ID = process.env.CHAT_MODEL ?? "syn:large:text";
export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://agentdocumentor:agentdocumentor@127.0.0.1:5432/agentdocumentor";

export function hasCredentials(): boolean {
  return existsSync(join(AGENT_DIR, "models.json")) || existsSync(join(AGENT_DIR, "auth.json"));
}

/**
 * Whether the database tier can run, decided by a QUERY.
 *
 * It used to ask Docker for the container's health, which answers a different question:
 * a container can be perfectly healthy while every connection fails — a volume
 * initialised with a password this checkout does not have does exactly that. Measured
 * consequence of asking the wrong question: a tier that used to skip ran, 19 tests
 * failed for a reason nothing in the failure named, and 19 more were cancelled.
 *
 * Availability is still decided at module load, because `before()` cannot skip; callers
 * therefore `await` this once at the top of their file and pass the result as `skip`.
 */
export async function databaseReady(): Promise<boolean> {
  return databaseAvailable();
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
