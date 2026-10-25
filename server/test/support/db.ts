import { randomUUID } from "node:crypto";
import { createDatabase, type Database } from "../../src/db/pool.ts";
import { migrate } from "../../src/db/migrate.ts";

export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://agentdocumentor:agentdocumentor@127.0.0.1:5432/agentdocumentor";

/** Connect, migrate once, and hand back a database for the test to close. */
export async function openTestDatabase(): Promise<Database> {
  const db = createDatabase(DATABASE_URL);
  await migrate(db);
  return db;
}

export async function databaseAvailable(): Promise<boolean> {
  const db = createDatabase(DATABASE_URL);
  try {
    await db.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await db.close();
  }
}

let counter = 0;

/** Unique user id per test, so tests never see each other's rows. */
export function testUser(label = "user"): string {
  counter += 1;
  return `test-${label}-${randomUUID().slice(0, 8)}-${counter}`;
}
