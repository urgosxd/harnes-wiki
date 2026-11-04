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

/**
 * In CI a database that cannot be reached is a FAILURE, not a reason to skip a tier.
 *
 * Skipping is the honest answer on a laptop; in a gate it is a lie that looks like a
 * pass, because the Postgres tier would silently disappear from the run. `scripts/ci.sh`
 * sets this, so an unreachable database stops the build.
 */
export const REQUIRE_DATABASE = process.env.CI_REQUIRE_DATABASE === "1";

/** The connection target without its password, safe to print in a failure message. */
function targetDescription(): string {
  try {
    const url = new URL(DATABASE_URL);
    return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
  } catch {
    return "the configured DATABASE_URL";
  }
}

export async function databaseAvailable(): Promise<boolean> {
  const db = createDatabase(DATABASE_URL);
  try {
    await db.query("SELECT 1");
    return true;
  } catch (error) {
    if (REQUIRE_DATABASE) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `CI_REQUIRE_DATABASE=1 but no database answered at ${targetDescription()}: ${reason}`,
      );
    }
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
