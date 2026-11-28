import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createDatabase, type Database } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { databaseReady, DATABASE_URL } from "./support/harness.ts";

/**
 * WHY THIS TEST EXISTS
 *
 * Migration 007 changes the SHAPE of two tables in opposite directions: it adds a
 * column that may be absent (a legacy document was never hashed, so it has no mark
 * and must keep saying so), and it replaces a single-column primary key with a
 * composite one (a document has one ingest state PER STACK, not one overall).
 *
 * Both are invisible from TypeScript: `recordIngest` writes what it is told, and a
 * dropped key still "works" until the day two rows are written for the same document.
 * So the schema is asserted where it actually lives, against a real Postgres.
 *
 * Nothing here asserts on a string dump of a constraint: the columns of the key are
 * read from `pg_constraint`, in order, because "the PK has these two columns" is the
 * rule and the name Postgres happens to give it is not a fact anyone depends on.
 */

const canRun = await databaseReady();
const skip = canRun ? false : "needs Postgres";

/** Columns of one constraint's key, in the order Postgres stores them. */
async function keyColumns(db: Database, table: string, contype: "p" | "f"): Promise<string[]> {
  const rows = await db.query<{ column: string }>(
    `SELECT a.attname AS column
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE n.nspname = current_schema()
        AND t.relname = $1
        AND c.contype = $2
      ORDER BY k.ord`,
    [table, contype],
  );
  return rows.map((row) => row.column);
}

/** Columns of one index, in order. */
async function indexColumns(db: Database, table: string, index: string): Promise<string[]> {
  const rows = await db.query<{ column: string }>(
    `SELECT a.attname AS column
       FROM pg_index i
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_class ix ON ix.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE n.nspname = current_schema()
        AND t.relname = $1
        AND ix.relname = $2
      ORDER BY k.ord`,
    [table, index],
  );
  return rows.map((row) => row.column);
}

async function column(
  db: Database,
  table: string,
  name: string,
): Promise<{ data_type: string; is_nullable: string } | undefined> {
  const rows = await db.query<{ data_type: string; is_nullable: string }>(
    `SELECT data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    [table, name],
  );
  return rows[0];
}

describe("documents and per-stack ingest state", { skip }, () => {
  let db: Database;

  before(async () => {
    db = createDatabase(DATABASE_URL);
    await migrate(db);
  });

  after(async () => {
    await db?.close();
  });

  test("007 is applied, so it sorts after 006 and is not silently skipped", async () => {
    const rows = await db.query<{ name: string }>(
      "SELECT name FROM schema_migrations WHERE name = $1",
      ["007_document_ingest_state.sql"],
    );
    assert.deepEqual(rows.map((row) => row.name), ["007_document_ingest_state.sql"]);
  });

  test("documents carries content_hash, nullable, so a legacy row has no mark", async () => {
    const found = await column(db, "documents", "content_hash");
    assert.deepEqual(found, { data_type: "text", is_nullable: "YES" });
  });

  test("the hash is indexed per user, because the mark is looked up per user", async () => {
    assert.deepEqual(await indexColumns(db, "documents", "documents_by_user_hash"), [
      "user_id",
      "content_hash",
    ]);
  });

  test("document_ingests carries stack_id, so one document holds one state per stack", async () => {
    const found = await column(db, "document_ingests", "stack_id");
    assert.equal(found?.data_type, "text");
    // The key below makes it NOT NULL; the column type is what this test owns.
    assert.ok(found, "document_ingests.stack_id must exist");
  });

  test("the primary key is the composite (document_id, stack_id)", async () => {
    assert.deepEqual(await keyColumns(db, "document_ingests", "p"), [
      "document_id",
      "stack_id",
    ]);
  });

  test("the old single-column primary key on document_id is gone", async () => {
    // Stated separately from the composite assertion: a second key would also be a
    // regression, and "the PK is X" says nothing about whether Y survived beside it.
    const single = await db.query<{ conname: string }>(
      `SELECT c.conname
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'document_ingests'
          AND c.contype = 'p'
          AND array_length(c.conkey, 1) = 1`,
    );
    assert.deepEqual(single.map((row) => row.conname), []);
  });

  test("deleting a document still cascades to its ingest rows", async () => {
    // Unchanged behaviour the key swap could have broken: the foreign key is what
    // makes a deleted document unable to keep a live ingest state.
    const rows = await db.query<{ confdeltype: string }>(
      `SELECT c.confdeltype
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'document_ingests'
          AND c.contype = 'f'`,
    );
    assert.deepEqual(rows.map((row) => row.confdeltype), ["c"]);
    assert.deepEqual(await keyColumns(db, "document_ingests", "f"), ["document_id"]);
  });
});
