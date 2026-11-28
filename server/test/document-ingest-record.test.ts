import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDatabase, type Database } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { DocumentStore } from "../src/db/document-store.ts";
import { capabilityPath } from "../src/api/document-routes.ts";
import { registerIngestRoutes } from "../src/api/ingest-routes.ts";
import { IngestClient } from "../src/ingest/client.ts";
import { createRouter } from "../src/http/router.ts";
import { createAuthenticator } from "../src/http/auth.ts";
import { databaseReady, testUser } from "./support/harness.ts";

/**
 * WHY THIS TEST EXISTS
 *
 * `document_ingests` is the ONLY local evidence that a document was handed to the
 * ingest service, and it is what the panel's "ingested" mark, the retract precondition
 * and the delete guard are all built on. Three things break it silently:
 *
 *  1. The row is written for a request the upstream REFUSED. A `409 busy` would then
 *     look ingested, and a retract would be attempted for a job that never ran.
 *  2. The row's identity is (document, Stack). Writing one row per document collapses
 *     independent per-Stack states, so retracting from one Stack looks like retracting
 *     from all of them, and a read for Stack B answers with Stack A's job id.
 *  3. Re-ingesting must RESET the row. Retraction is reversible (S7): a permanent
 *     tombstone would mean a document could never be marked again.
 *
 * `last_status` is asserted as `requested` and nothing else: nothing server-side follows
 * the job, so any other value here would claim a state this server never observed.
 */

const USER = testUser("ingest");
const TOKEN = "test-token-value-1234";
const OTHER = testUser("foreign");
const OTHER_TOKEN = "other-token-value-1234";
const STACK_A = "stack-alpha";
const STACK_B = "stack-beta";

const canRun = await databaseReady();
const skip = canRun ? false : "needs Postgres";

describe("document ingests are recorded per document and Stack", { skip }, () => {
  let db: Database;
  let store: DocumentStore;
  let server: Server;
  let baseUrl: string;
  let upstream: Server;
  /** What the stand-in service answers for the next create, and the job id it names. */
  let answer: { status: number; body: unknown } = { status: 202, body: { jobId: "job_1" } };

  before(async () => {
    db = createDatabase(
      process.env.DATABASE_URL ??
        "postgres://agentdocumentor:agentdocumentor@127.0.0.1:5432/agentdocumentor",
    );
    await migrate(db);
    store = new DocumentStore(db);

    upstream = createServer(async (req, res) => {
      // Drain the body: a socket left half-read keeps the connection unusable.
      for await (const _chunk of req) void _chunk;
      if (req.method === "GET" && (req.url ?? "").startsWith("/stacks")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ stacks: [{ id: STACK_A }, { id: STACK_B }] }));
        return;
      }
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

    const router = createRouter({
      authenticate: createAuthenticator({ users: `${USER}:${TOKEN},${OTHER}:${OTHER_TOKEN}` }),
    });
    registerIngestRoutes(router, {
      ingest: new IngestClient({ baseUrl: upstreamBase, timeoutMs: 2000 }),
      documents: {
        urlFor: async (documentId, userId) => {
          const found = await store.findOwned(documentId, userId);
          return found ? `http://agentdoc-server:8080${capabilityPath(found)}` : undefined;
        },
      },
      ingests: store,
    });
    server = await router.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    // Every row this file wrote hangs off a document it created, and the foreign key
    // cascades, so removing the documents restores the shared database.
    await db?.query("DELETE FROM documents WHERE user_id = ANY($1)", [[USER, OTHER]]);
    server?.close();
    if (upstream) await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await db?.close();
  });

  /** One uploaded document, owned by `userId`. */
  const upload = async (userId = USER, filename = "informe.pdf") =>
    store.create({
      userId,
      filename,
      contentType: "application/pdf",
      content: Buffer.from("%PDF-1.4 recorded"),
    });

  /** Start an ingest for a document, as the browser would. */
  const ingest = async (
    documentId: string,
    stackId: string | undefined,
    token = TOKEN,
    userId = USER,
  ) =>
    fetch(`${baseUrl}/ingest/jobs`, {
      method: "POST",
      headers: {
        "x-dev-token": token,
        "x-user-id": userId,
        "content-type": "application/json",
      },
      body: JSON.stringify(stackId === undefined ? { documentId } : { documentId, stackId }),
    });

  /** Every recorded row for one document, ordered so a diff is readable. */
  const rows = async (documentId: string) =>
    db.query<{
      document_id: string;
      stack_id: string;
      job_id: string | null;
      last_status: string;
      user_id: string;
    }>(
      `SELECT document_id, stack_id, job_id, last_status, user_id
         FROM document_ingests
        WHERE document_id = $1
        ORDER BY stack_id`,
      [documentId],
    );

  /** How many states this user holds, so a negative can be asserted without a dump. */
  const countFor = async (userId: string): Promise<number> => {
    const found = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM document_ingests WHERE user_id = $1",
      [userId],
    );
    return found[0]?.count ?? 0;
  };

  test("an accepted ingest writes exactly one row naming the job and the Stack", async () => {
    const document = await upload();
    answer = { status: 202, body: { jobId: "job_alpha_1" } };

    const res = await ingest(document.id, STACK_A);
    assert.equal(res.status, 202);
    const body = (await res.json()) as { jobId?: string };
    assert.equal(body.jobId, "job_alpha_1", "the accepted body is still passed through");

    assert.deepEqual(await rows(document.id), [
      {
        document_id: document.id,
        stack_id: STACK_A,
        job_id: "job_alpha_1",
        last_status: "requested",
        user_id: USER,
      },
    ]);
  });

  test("re-ingesting the same document in the same Stack updates the one row", async () => {
    const document = await upload();
    answer = { status: 202, body: { jobId: "job_beta_1" } };
    await ingest(document.id, STACK_A);

    answer = { status: 202, body: { jobId: "job_beta_2" } };
    await ingest(document.id, STACK_A);

    // One row, latest job: a history of requests is not what any caller reads.
    assert.deepEqual((await rows(document.id)).map((row) => [row.stack_id, row.job_id]), [
      [STACK_A, "job_beta_2"],
    ]);
  });

  test("the same document in another Stack is a SECOND state, not an overwrite", async () => {
    const document = await upload();
    answer = { status: 202, body: { jobId: "job_two_a" } };
    await ingest(document.id, STACK_A);
    answer = { status: 202, body: { jobId: "job_two_b" } };
    await ingest(document.id, STACK_B);

    assert.deepEqual(
      (await rows(document.id)).map((row) => [row.stack_id, row.job_id]),
      [
        [STACK_A, "job_two_a"],
        [STACK_B, "job_two_b"],
      ],
    );
  });

  test("a refused start writes no row at all: 409 busy is not an ingest", async () => {
    const document = await upload();
    answer = { status: 202, body: { jobId: "job_before_refusal" } };
    await ingest(document.id, STACK_A);
    const before = await rows(document.id);
    assert.equal(before.length, 1);

    answer = { status: 409, body: { error: "busy" } };
    const busy = await ingest(document.id, STACK_A);
    assert.equal(busy.status, 409, "the refusal still reaches the caller unchanged");
    // Same row, same job: a refused request must not even touch `updated_at`'s meaning.
    assert.deepEqual(await rows(document.id), before);
  });

  test("a failing upstream start writes no row either, and still answers 502", async () => {
    const document = await upload();
    answer = { status: 202, body: { jobId: "job_before_error" } };
    await ingest(document.id, STACK_A);
    const before = await rows(document.id);

    answer = { status: 500, body: { error: "boom" } };
    const failed = await ingest(document.id, STACK_A);
    assert.equal(failed.status, 502);
    assert.deepEqual(await rows(document.id), before);
  });

  test("re-ingest RESETS a retracted row, because retraction is reversible", async () => {
    const document = await upload();
    answer = { status: 202, body: { jobId: "job_retract_1" } };
    await ingest(document.id, STACK_A);

    // The retraction this feature adds writes this value; there is no tombstone.
    await db.query(
      "UPDATE document_ingests SET last_status = 'retracted' WHERE document_id = $1 AND stack_id = $2",
      [document.id, STACK_A],
    );
    assert.equal((await rows(document.id))[0]?.last_status, "retracted");

    answer = { status: 202, body: { jobId: "job_retract_2" } };
    await ingest(document.id, STACK_A);

    const after = await rows(document.id);
    assert.equal(after.length, 1, "still one row per document and Stack");
    assert.equal(after[0]?.last_status, "requested", "the reset is the whole point of S7");
    assert.equal(after[0]?.job_id, "job_retract_2");
  });

  test("a source-kind job is never recorded: this table is about uploads", async () => {
    // A URL or a path the service reads by itself has no document row here, so there is
    // nothing the state could point at. The job must still start normally.
    const before = await countFor(USER);
    answer = { status: 202, body: { jobId: "job_source_1" } };
    const res = await fetch(`${baseUrl}/ingest/jobs`, {
      method: "POST",
      headers: { "x-dev-token": TOKEN, "x-user-id": USER, "content-type": "application/json" },
      body: JSON.stringify({ source: "https://example.com/article", stackId: STACK_A }),
    });
    assert.equal(res.status, 202);
    assert.equal(await countFor(USER), before, "a source job has no document to record");
  });

  test("a document ingest that names no Stack still starts, and records nothing", async () => {
    // The row's identity is (document, Stack). With no Stack named there is no identity
    // to write, and guessing the endpoint's bound Stack would file the compile under a
    // tenant nobody chose - which is exactly what S8 makes impossible to undo.
    const document = await upload();
    answer = { status: 202, body: { jobId: "job_no_stack" } };

    const res = await ingest(document.id, undefined);
    assert.equal(res.status, 202);
    assert.deepEqual(await rows(document.id), []);
  });

  test("another user's document answers 404 and records nothing", async () => {
    const foreign = await upload(OTHER, "ajeno.pdf");
    answer = { status: 202, body: { jobId: "job_never" } };

    const res = await ingest(foreign.id, STACK_A);
    assert.equal(res.status, 404);
    assert.deepEqual(await rows(foreign.id), []);
  });

  test("a Stack nobody ingested into has no state for that document", async () => {
    const document = await upload();
    answer = { status: 202, body: { jobId: "job_lookup_a" } };
    await ingest(document.id, STACK_A);
    answer = { status: 202, body: { jobId: "job_lookup_b" } };
    await ingest(document.id, STACK_B);

    // The read answers for the Stack it was ASKED about, never the first row it finds.
    const alpha = await store.ingestFor(document.id, USER, STACK_A);
    const beta = await store.ingestFor(document.id, USER, STACK_B);
    assert.equal(alpha?.stackId, STACK_A);
    assert.equal(alpha?.jobId, "job_lookup_a");
    assert.equal(beta?.stackId, STACK_B);
    assert.equal(beta?.jobId, "job_lookup_b");

    assert.equal(await store.ingestFor(document.id, USER, "stack-never-used"), undefined);
    // Ownership still applies: the row is not readable by another user.
    assert.equal(await store.ingestFor(document.id, OTHER, STACK_A), undefined);
  });
});
