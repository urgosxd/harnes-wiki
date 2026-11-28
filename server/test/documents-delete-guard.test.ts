import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDatabase, type Database } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { DocumentStore } from "../src/db/document-store.ts";
import { registerDocumentRoutes } from "../src/api/document-routes.ts";
import { DocumentIngestState } from "../src/api/document-ingest-state.ts";
import { createRouter } from "../src/http/router.ts";
import { createAuthenticator } from "../src/http/auth.ts";
import { databaseReady, testUser } from "./support/harness.ts";

/**
 * WHY THIS TEST EXISTS
 *
 * Deleting a `documents` row CASCADES every stack's ingest state with it, so the delete
 * has to refuse while the wiki still holds the compiled source. Two ways to get that
 * wrong, both silent:
 *
 *  1. Scoping the guard to the `x-stack-id` of the REQUEST. A document ingested into
 *     Stack B, deleted by a request that names Stack A (or names nothing), would then be
 *     deleted along with Stack B's state and no retraction ever happened. That makes
 *     "omit the header" the way to bypass the guard, so the guard is asserted here with
 *     the header ABSENT and with the header naming a Stack that holds no row.
 *  2. Answering the guard BEFORE ownership. A `409` for somebody else's document tells
 *     the caller that document exists and is ingested; the answer for a foreign document
 *     must stay the identical `404` it is today, whatever its rows say.
 *
 * `retracted` is the only status that unblocks: retraction is reversible (S7), so an
 * every-row-retracted document deletes normally, and any single active row is enough to
 * refuse. Nothing here may talk to the wiki, so the stand-in client counts its calls.
 */

const USER = testUser("delete-guard");
const TOKEN = "test-token-value-1234";
const OTHER = testUser("delete-guard-foreign");
const OTHER_TOKEN = "other-token-value-1234";
const STACK_A = "stack-alpha";
const STACK_B = "stack-beta";
const STACK_EMPTY = "stack-never-ingested";

const canRun = await databaseReady();
const skip = canRun ? false : "needs Postgres";

describe("deleting a document refuses while an ingest is still live", { skip }, () => {
  let db: Database;
  let store: DocumentStore;
  let server: Server;
  let baseUrl: string;
  /** Every call the delete path made to the wiki. The guard is local state only. */
  let wikiCalls = 0;

  before(async () => {
    db = createDatabase(
      process.env.DATABASE_URL ?? "postgres://agentdocumentor:agentdocumentor@127.0.0.1:5432/agentdocumentor",
    );
    await migrate(db);
    store = new DocumentStore(db);

    const router = createRouter({
      authenticate: createAuthenticator({ users: `${USER}:${TOKEN},${OTHER}:${OTHER_TOKEN}` }),
    });
    registerDocumentRoutes(router, {
      documents: store,
      publicBaseUrl: "http://agentdoc-server:8080",
      // Present on purpose: the guard must decide from OUR rows. A guard that asked the
      // wiki would show up as a call here.
      ingestState: new DocumentIngestState({
        ingest: {
          listStackDocuments: async () => {
            wikiCalls += 1;
            return { status: 200, body: { documents: [] } };
          },
        },
        ingests: store,
      }),
    });
    server = await router.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    // Every row here hangs off a document this file created, and both foreign keys
    // cascade, so removing the documents leaves the shared database as it was found.
    await db?.query("DELETE FROM documents WHERE user_id = ANY($1)", [[USER, OTHER]]);
    server?.close();
    await db?.close();
  });

  /** One uploaded document, owned by `userId`. */
  const upload = async (userId = USER, filename = "informe.pdf") =>
    store.create({
      userId,
      filename,
      contentType: "application/pdf",
      content: Buffer.from("%PDF-1.4 guarded"),
    });

  /** Record an ingest state, as a request to the ingest service would have. */
  const record = async (
    documentId: string,
    stackId: string,
    status = "requested",
    userId = USER,
  ) => store.recordIngest({ documentId, stackId, userId, jobId: `job_${stackId}`, status });

  /** The exact refusal the contract names, for one document. */
  const refusedBody = (id: string) => ({
    error: "document_ingested",
    message: `Document "${id}" is ingested; retract it with POST /documents/${id}/retract before deleting it`,
  });

  /**
   * DELETE a document, authenticated as `userId`, naming `stackId` only when given.
   *
   * Asserts on the way through that no delete talked to the wiki: the refusal is decided
   * from our own rows, and one round trip upstream would make a local check depend on the
   * other service's availability.
   */
  const remove = async (
    documentId: string,
    options: { stackId?: string; token?: string; userId?: string } = {},
  ): Promise<{ status: number; body: unknown }> => {
    const headers: Record<string, string> = {
      "x-dev-token": options.token ?? TOKEN,
      "x-user-id": options.userId ?? USER,
    };
    if (options.stackId !== undefined) headers["x-stack-id"] = options.stackId;
    const before = wikiCalls;
    const res = await fetch(`${baseUrl}/documents/${documentId}`, { method: "DELETE", headers });
    const body = res.status === 204 ? undefined : await res.json();
    assert.equal(wikiCalls, before, "deleting a document must not call the wiki");
    return { status: res.status, body };
  };

  /** Every recorded row for one document, ordered so a diff is readable. */
  const rows = async (documentId: string) =>
    db.query<{ stack_id: string; last_status: string }>(
      "SELECT stack_id, last_status FROM document_ingests WHERE document_id = $1 ORDER BY stack_id",
      [documentId],
    );

  test("an ingest live in the request's own Stack is refused, and nothing is deleted", async () => {
    const document = await upload();
    await record(document.id, STACK_A);

    const res = await remove(document.id, { stackId: STACK_A });

    assert.equal(res.status, 409);
    assert.deepEqual(res.body, refusedBody(document.id));
    assert.ok(await store.findOwned(document.id, USER), "the document must still be there");
    assert.deepEqual(await rows(document.id), [{ stack_id: STACK_A, last_status: "requested" }]);
  });

  test("a live ingest in ANOTHER Stack blocks the delete when the request names no Stack", async () => {
    // The bypass test: scoping the guard to the request's Stack would let this delete
    // cascade Stack A's live state, with no retraction behind it.
    const document = await upload();
    await record(document.id, STACK_A);

    const res = await remove(document.id);

    assert.equal(res.status, 409);
    assert.deepEqual(res.body, refusedBody(document.id));
    assert.ok(await store.findOwned(document.id, USER));
    assert.deepEqual(await rows(document.id), [{ stack_id: STACK_A, last_status: "requested" }]);
  });

  test("a Stack that holds no row does not make another Stack's state deletable", async () => {
    const document = await upload();
    await record(document.id, STACK_A);

    const res = await remove(document.id, { stackId: STACK_EMPTY });

    assert.equal(res.status, 409);
    assert.deepEqual(res.body, refusedBody(document.id));
    assert.ok(await store.findOwned(document.id, USER));
    assert.deepEqual(await rows(document.id), [{ stack_id: STACK_A, last_status: "requested" }]);
  });

  test("every row retracted means the ingest cascade is the right thing to do", async () => {
    const document = await upload();
    await record(document.id, STACK_A, "retracted");
    await record(document.id, STACK_B, "retracted");

    const res = await remove(document.id, { stackId: STACK_A });

    assert.equal(res.status, 204);
    assert.equal(res.body, undefined);
    assert.equal(await store.findOwned(document.id, USER), undefined, "the document is gone");
    assert.deepEqual(await rows(document.id), [], "its ingest states cascaded with it");
  });

  test("a document nobody ingested still deletes, exactly as before", async () => {
    const document = await upload();

    const res = await remove(document.id);

    assert.equal(res.status, 204);
    assert.equal(await store.findOwned(document.id, USER), undefined);
    assert.deepEqual(await rows(document.id), []);
  });

  test("another user's document is not found, and its ingest state stays unknown", async () => {
    const foreign = await upload(OTHER, "ajeno.pdf");
    await record(foreign.id, STACK_A, "requested", OTHER);

    const res = await remove(foreign.id, { stackId: STACK_A });

    // The ordinary 404, byte for byte: a 409 here would confirm the document exists and
    // is ingested, which is a leak the ownership check exists to prevent.
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: "not_found", message: "no such document" });
    assert.ok(await store.findOwned(foreign.id, OTHER), "somebody else's document is untouched");
    assert.deepEqual(await rows(foreign.id), [{ stack_id: STACK_A, last_status: "requested" }]);
  });

  test("one retracted row and one live row still blocks: any live row is enough", async () => {
    const document = await upload();
    await record(document.id, STACK_A, "retracted");
    await record(document.id, STACK_B, "requested");

    const res = await remove(document.id, { stackId: STACK_A });

    assert.equal(res.status, 409);
    assert.deepEqual(res.body, refusedBody(document.id));
    assert.ok(await store.findOwned(document.id, USER));
    assert.deepEqual(await rows(document.id), [
      { stack_id: STACK_A, last_status: "retracted" },
      { stack_id: STACK_B, last_status: "requested" },
    ]);
  });
});
