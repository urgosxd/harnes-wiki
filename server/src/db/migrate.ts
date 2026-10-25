import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "./pool.ts";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Apply every unapplied migration in filename order.
 *
 * Each migration runs inside its own transaction together with the row that
 * records it, so a failure leaves neither the schema change nor the bookkeeping
 * behind. Advisory locking keeps two starting instances from applying the same
 * migration concurrently.
 */
export async function migrate(db: Database): Promise<MigrationResult> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql")).sort();

  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  // Two processes booting at once must not race on the same file.
  const LOCK_KEY = 4_170_001;
  await db.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
  try {
    const done = new Set(
      (await db.query<{ name: string }>("SELECT name FROM schema_migrations")).map((row) => row.name),
    );

    const applied: string[] = [];
    const skipped: string[] = [];

    for (const file of files) {
      if (done.has(file)) {
        skipped.push(file);
        continue;
      }
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      await db.transaction(async (tx) => {
        await tx.query(sql);
        await tx.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      });
      applied.push(file);
    }

    return { applied, skipped };
  } finally {
    await db.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
  }
}
