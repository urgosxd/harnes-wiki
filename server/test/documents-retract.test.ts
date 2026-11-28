import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { createDatabase, type Database } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { DocumentStore } from "../src/db/document-store.ts";
import { registerDocumentRoutes } from "../src/api/document-routes.ts";
import { DocumentRetraction } from "../src/api/document-retraction.ts";
import { IngestClient } from "../src/ingest/client.ts";
import { createRouter } from "../src/http/router.ts";
import { createAuthenticator } from "../src/http/auth.ts";
import { databaseReady, testUser } from "./support/harness.ts";

/**
 * WHY THIS TEST EXISTS
 *
 * `POST /documents/:id/retract` is the endpoint that makes the wiki DELETE the compiled
 * source and recompile without it. Four ways of getting it wrong are invisible on
 * screen, and each has a case below:
 *
 *  1. ANSWERING A LOCAL GATE WE DO NOT OWN. Whether the wiki still holds "something"
 *     is not our question: the presence of a `document_ingests` row is the ONLY local
 *     gate, so the handler must never branch on `ingest.current`. A handler that
 *     inspected `current` would refuse exactly the retraction an owner most wants — the
 *     one whose file changed — and no test of the happy path would notice.
 *  2. PRETENDING A RETRACTION HAPPENED IN A DEPLOYMENT THAT CANNOT PERFORM ONE. With
 *     `SOURCE_RETRACTION_ENABLED` off, the answer is a `503` that names the variable,
 *     with no upstream call and the row left exactly as it was. Writing `retracted`
 *     there would be a state nothing performed.
 *  3. ADDRESSING THE WRONG THING UPSTREAM. The wiki deletes the file IT stored, whose
 *     identity is its own `storage_path` — not our document id, not the filename. Sent
 *     raw, a `storage_path` with slashes addresses three segments the wiki does not
 *     have, so the encoding is asserted from the bytes that arrived on the wire.
 *  4. THE WRONG ANSWER FOR "THERE WAS NOTHING TO RETRACT". The upstream's
 *     `404 source_not_found` becomes our `409 document_not_ingested`, carrying the
 *     upstream's own sentence: one client-visible code, and no `retracted` row for a
 *     deletion that never happened.
 *
 * The wiki is stubbed at the TRANSPORT (a real HTTP server answering the real routes),
 * never at the client class: the paths this adapter builds, the query-vs-path choice and
 * the encoding are part of what this file proves.
 */

const USER = testUser("retract");
const TOKEN = "test-token-value-1234";
const OTHER = testUser("retract-foreign");
const OTHER_TOKEN = "other-token-value-1234";
const STACK = "stack-retract-0001";

/** The wiki's own handle for a source, which is what a retraction addresses. */
const STORAGE_PATH = "wiki/sources/informe.md";
const RETRACT_JOB = "ing_retract_1";

/** The bytes one upload holds, and the digest the wiki publishes for them. */
const INGESTED_BYTES = Buffer.from("%PDF-1.4 retractable content");
const INGESTED_HASH = createHash("sha256").update(INGESTED_BYTES).digest("hex");

const listingBody = (rows: WikiRow[]) => ({ documents: rows });

interface WikiRow {
  source_hash: string;
  ingested_at: string | null;
  storage_path: string | null;
}

type WikiAnswer = { status: number; body: unknown } | "explode";

const canRun = await databaseReady();
const skip = canRun ? false : "needs Postgres";

describe("POST /documents/:id/retract removes the compiled source from the wiki", { skip }, () => {
  let db: Database;
  let store: DocumentStore;
  /** The gateway as a deployment ships it: retraction enabled. */
  let enabled: Server;
  /** The same routes with `SOURCE_RETRACTION_ENABLED` off. */
  let disabled: Server;
  let enabledUrl: string;
  let disabledUrl: string;
  let upstream: Server;

  /** What the wiki lists per Stack, and what it answers a DELETE with. */
  let wikiListings = new Map<string, WikiAnswer>();
  let deleteAnswer: WikiAnswer = { status: 202, body: { deleted: true, jobId: RETRACT_JOB } };
  /** Every upstream call this file made, so "zero calls" is an assertion. */
  let listingCalls: string[] = [];
  let deleteCalls: { rawPath: string; identity: string; stackId: string }[] = [];

  const headers = (options: { token?: string; userId?: string; stackId?: string | null } = {}) => {
    const result: Record<string, string> = {
      "x-dev-token": options.token ?? TOKEN,
      "x-user-id": options.userId ?? USER,
    };
    if (options.stackId !== null) result["x-stack-id"] = options.stackId ?? STACK;
    return result;
  };

  before(async () => {
    db = createDatabase(
      process.env.DATABASE_URL ?? "postgres://agentdocumentor:agentdocumentor@127.0.0.1:5432/agentdocumentor",
    );
    await migrate(db);
    store = new DocumentStore(db);

    upstream = createServer(async (req, res) => {
      for await (const _chunk of req) void _chunk;
      const url = req.url ?? "";

      const listing = /^\/stacks\/([^/]+)\/documents$/.exec(url);
      if (listing) {
        const stackId = decodeURIComponent(listing[1]!);
        listingCalls.push(stackId);
        const answer = wikiListings.get(stackId);
        if (answer === undefined) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(listingBody([])));
          return;
        }
        if (answer === "explode") {
          res.destroy();
          return;
        }
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(JSON.stringify(answer.body));
        return;
      }

      const deletion = /^\/stacks\/([^/]+)\/sources\/(.+)$/.exec(url);
      if (deletion) {
        // The RAW path is recorded on purpose: `%2F` and `%20` surviving to the wire is
        // what makes the identity ONE segment, and decoding first would hide that.
        deleteCalls.push({
          rawPath: url,
          identity: decodeURIComponent(deletion[2]!),
          stackId: decodeURIComponent(deletion[1]!),
        });
        const answer = deleteAnswer;
        if (answer === "explode") {
          res.destroy();
          return;
        }
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(JSON.stringify(answer.body));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "not_found" } }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

    const client = new IngestClient({ baseUrl: upstreamBase, timeoutMs: 2000 });
    const gateways = [
      { enabled: true, url: (value: string) => (enabledUrl = value) },
      { enabled: false, url: (value: string) => (disabledUrl = value) },
    ];
    for (const gateway of gateways) {
      const router = createRouter({
        authenticate: createAuthenticator({ users: `${USER}:${TOKEN},${OTHER}:${OTHER_TOKEN}` }),
      });
      registerDocumentRoutes(router, {
        documents: store,
        publicBaseUrl: "http://agentdoc-server:8080",
        retraction: new DocumentRetraction({
          client,
          ingests: store,
          enabled: gateway.enabled,
        }),
      });
      const server = await router.listen(0, "127.0.0.1");
      gateway.url(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      if (gateway.enabled) enabled = server;
      else disabled = server;
    }
  });

  after(async () => {
    // Every row here hangs off a document this file created and both foreign keys
    // cascade, so removing the documents leaves the shared database as it was found.
    await db?.query("DELETE FROM documents WHERE user_id = ANY($1)", [[USER, OTHER]]);
    enabled?.close();
    disabled?.close();
    if (upstream) await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await db?.close();
  });

  /** A Stack nobody else used, so no listing can answer for another case. */
  const freshStack = (label: string) => `${STACK}-${label}-${randomUUID().slice(0, 8)}`;

  /** Upload real bytes through the real endpoint, so the content hash is the real one. */
  const upload = async (content: Buffer, filename = "informe.pdf", token = TOKEN, userId = USER) => {
    const res = await fetch(`${enabledUrl}/documents?filename=${encodeURIComponent(filename)}`, {
      method: "POST",
      headers: { ...headers({ token, userId }), "content-type": "application/pdf" },
      body: content,
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { id: string };
    return body.id;
  };

  const record = async (
    documentId: string,
    stackId: string,
    status = "requested",
    userId = USER,
  ) => store.recordIngest({ documentId, stackId, userId, jobId: `job_${stackId}`, status });

  /** The wiki row that describes these bytes, with the identity a retraction needs. */
  const wikiRow = (storagePath = STORAGE_PATH): WikiRow => ({
    source_hash: INGESTED_HASH,
    ingested_at: "2026-09-21T10:00:00.000Z",
    storage_path: storagePath,
  });

  const rows = async (documentId: string) =>
    db.query<{ stack_id: string; last_status: string }>(
      "SELECT stack_id, last_status FROM document_ingests WHERE document_id = $1 ORDER BY stack_id",
      [documentId],
    );

  /**
   * Call the endpoint, asserting zero upstream calls when `upstream: false`.
   *
   * "Zero upstream calls" is the assertion for every refusal decided without the wiki:
   * a retraction that first asked the wiki what it holds would make a local refusal
   * depend on the other service being up.
   */
  const retract = async (
    documentId: string,
    options: {
      server?: "enabled" | "disabled";
      stackId?: string | null;
      token?: string;
      userId?: string;
      upstream?: boolean;
    } = {},
  ): Promise<{ status: number; body: unknown }> => {
    const before = { listings: [...listingCalls], deletes: [...deleteCalls] };
    const base = options.server === "disabled" ? disabledUrl : enabledUrl;
    const res = await fetch(`${base}/documents/${documentId}/retract`, {
      method: "POST",
      headers: headers({
        stackId: options.stackId ?? null,
        ...(options.token === undefined ? {} : { token: options.token }),
        ...(options.userId === undefined ? {} : { userId: options.userId }),
      }),
    });
    const body = await res.json();
    if (options.upstream === false) {
      assert.deepEqual(listingCalls, before.listings, "this refusal must not read the wiki");
      assert.deepEqual(deleteCalls, before.deletes, "this refusal must not call the wiki");
    }
    return { status: res.status, body };
  };

  test("no recorded ingest is the ONLY local gate: 409 document_not_ingested, no upstream call", async () => {
    const stackId = freshStack("norow");
    const documentId = await upload(INGESTED_BYTES);
    // The wiki DOES hold these bytes. That is irrelevant: nothing is recorded here, and
    // whether there was "something to retract" is not our question to answer.
    wikiListings.set(stackId, { status: 200, body: listingBody([wikiRow()]) });

    const res = await retract(documentId, { stackId, upstream: false });

    assert.equal(res.status, 409);
    assert.deepEqual(res.body, {
      error: "document_not_ingested",
      message: `Document "${documentId}" has no ingest recorded in Stack "${stackId}"; there is nothing to retract`,
    });
    assert.deepEqual(await rows(documentId), [], "a refusal must not create a row either");
  });

  test("a foreign document is the ordinary 404, and ownership is answered before the gate", async () => {
    const stackId = freshStack("foreign");
    const documentId = await upload(INGESTED_BYTES, "ajeno.pdf", OTHER_TOKEN, OTHER);
    // A row EXISTS for it, so the gate would answer 409 if it were evaluated first —
    // which would confirm both that the document exists and that it was ingested.
    await record(documentId, stackId, "requested", OTHER);

    const res = await retract(documentId, { stackId, upstream: false });

    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: "not_found", message: "no such document" });
    assert.deepEqual(await rows(documentId), [{ stack_id: stackId, last_status: "requested" }]);
  });

  test("no x-stack-id is a 400: a retraction addresses one Stack, never a guess", async () => {
    const stackId = freshStack("nostack");
    const documentId = await upload(INGESTED_BYTES);
    await record(documentId, stackId);

    const res = await retract(documentId, { stackId: null, upstream: false });

    assert.equal(res.status, 400);
    assert.deepEqual(res.body, {
      error: "invalid_stack_id",
      message: "send one x-stack-id header naming the Stack to retract from",
    });
    assert.deepEqual(await rows(documentId), [{ stack_id: stackId, last_status: "requested" }]);
  });

  test("with SOURCE_RETRACTION_ENABLED off it answers 503 and performs nothing", async () => {
    const stackId = freshStack("disabled");
    const documentId = await upload(INGESTED_BYTES);
    await record(documentId, stackId);
    wikiListings.set(stackId, { status: 200, body: listingBody([wikiRow()]) });

    const res = await retract(documentId, { stackId, server: "disabled", upstream: false });

    assert.equal(res.status, 503);
    const body = res.body as { error: string; message: string };
    assert.equal(body.error, "source_retraction_unavailable");
    assert.match(body.message, /SOURCE_RETRACTION_ENABLED/, "the message must name the variable");
    // A disabled deployment must not pretend a retraction happened.
    assert.deepEqual(await rows(documentId), [{ stack_id: stackId, last_status: "requested" }]);
  });

  test("enabled, with a matching wiki row: 202 with the job id, and the row becomes retracted", async () => {
    const stackId = freshStack("ok");
    const documentId = await upload(INGESTED_BYTES);
    await record(documentId, stackId);
    wikiListings.set(stackId, { status: 200, body: listingBody([wikiRow()]) });
    deleteAnswer = { status: 202, body: { deleted: true, jobId: RETRACT_JOB } };
    const before = deleteCalls.length;

    const res = await retract(documentId, { stackId, upstream: true });

    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { jobId: RETRACT_JOB });
    assert.equal(deleteCalls.length, before + 1, "exactly one deletion");
    const sent = deleteCalls[before]!;
    assert.equal(sent.stackId, stackId);
    assert.equal(sent.identity, STORAGE_PATH);
    assert.equal(sent.rawPath, `/stacks/${stackId}/sources/${encodeURIComponent(STORAGE_PATH)}`);
    assert.deepEqual(await rows(documentId), [{ stack_id: stackId, last_status: "retracted" }]);
  });

  test("an upstream 'nothing to retract' becomes 409 document_not_ingested, in the wiki's own words", async () => {
    const stackId = freshStack("upstream404");
    const documentId = await upload(INGESTED_BYTES);
    await record(documentId, stackId);
    wikiListings.set(stackId, { status: 200, body: listingBody([wikiRow()]) });
    const said = `no source "wiki/sources/informe.md" in Stack "${stackId}"`;
    deleteAnswer = { status: 404, body: { error: { code: "source_not_found", message: said } } };
    const before = deleteCalls.length;

    const res = await retract(documentId, { stackId, upstream: true });

    assert.equal(res.status, 409);
    // ONE client-visible code for "there was nothing to retract", and the upstream's
    // sentence preserved: it names the source, which ours cannot.
    assert.deepEqual(res.body, { error: "document_not_ingested", message: said });
    assert.equal(deleteCalls.length, before + 1);
    assert.deepEqual(
      await rows(documentId),
      [{ stack_id: stackId, last_status: "requested" }],
      "a deletion that did not happen must not be recorded as one",
    );
  });

  test("an upstream 409 busy is our 409 busy: the wiki already has a mutation in flight", async () => {
    const stackId = freshStack("busy");
    const documentId = await upload(INGESTED_BYTES);
    await record(documentId, stackId);
    wikiListings.set(stackId, { status: 200, body: listingBody([wikiRow()]) });
    const said = "a compile for this Stack is running; the retraction was not applied";
    deleteAnswer = { status: 409, body: { error: { code: "busy", message: said } } };

    const res = await retract(documentId, { stackId, upstream: true });

    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: "busy", message: said });
    assert.deepEqual(
      await rows(documentId),
      [{ stack_id: stackId, last_status: "requested" }],
      "a refused retraction leaves the state alone",
    );
  });

  test("no wiki row holds our content hash: 503, and no identity is guessed", async () => {
    const stackId = freshStack("nohash");
    const documentId = await upload(INGESTED_BYTES);
    await record(documentId, stackId);
    // The wiki answered, and its only row describes DIFFERENT bytes. There is no
    // identity to address, so nothing may be sent: an empty path segment would name a
    // collection, not a source.
    wikiListings.set(stackId, {
      status: 200,
      body: listingBody([
        {
          source_hash: createHash("sha256").update("otras cosas").digest("hex"),
          ingested_at: "2026-09-21T10:00:00.000Z",
          storage_path: "wiki/sources/otro.md",
        },
      ]),
    });
    const before = deleteCalls.length;

    const res = await retract(documentId, { stackId, upstream: true });

    assert.equal(res.status, 503);
    assert.equal((res.body as { error: string }).error, "source_retraction_unavailable");
    assert.equal(deleteCalls.length, before, "no identity, no request");
    assert.deepEqual(await rows(documentId), [{ stack_id: stackId, last_status: "requested" }]);
  });

  test("re-ingesting a retracted document resets its state: no tombstone survives", async () => {
    const stackId = freshStack("reversible");
    const documentId = await upload(INGESTED_BYTES);
    await record(documentId, stackId);
    wikiListings.set(stackId, { status: 200, body: listingBody([wikiRow()]) });
    deleteAnswer = { status: 202, body: { deleted: true, jobId: RETRACT_JOB } };
    await retract(documentId, { stackId });
    assert.deepEqual(await rows(documentId), [{ stack_id: stackId, last_status: "retracted" }]);

    // The reversal is the WRITE path's, asserted through it rather than by hand: the
    // next ingest of the same document in the same Stack is live again.
    const again = await store.recordIngest({
      documentId,
      stackId,
      userId: USER,
      jobId: "job_second",
      status: "requested",
    });
    assert.equal(again.lastStatus, "requested");
    assert.equal(again.jobId, "job_second");
    assert.deepEqual(await rows(documentId), [{ stack_id: stackId, last_status: "requested" }]);
  });

  test("the identity travels as ONE encoded path segment, slashes and spaces included", async () => {
    const stackId = freshStack("encoding");
    const documentId = await upload(INGESTED_BYTES);
    await record(documentId, stackId);
    // A real storage path with a slash AND a space. Sent raw, this addresses three
    // segments and one with a space, neither of which the wiki has.
    const identity = "wiki/sources/informe final.md";
    wikiListings.set(stackId, { status: 200, body: listingBody([wikiRow(identity)]) });
    deleteAnswer = { status: 202, body: { deleted: true, jobId: RETRACT_JOB } };
    const before = deleteCalls.length;

    const res = await retract(documentId, { stackId, upstream: true });

    assert.equal(res.status, 202);
    const sent = deleteCalls[before]!;
    assert.equal(sent.rawPath, `/stacks/${stackId}/sources/wiki%2Fsources%2Finforme%20final.md`);
    assert.equal(sent.identity, identity, "and it decodes back to the wiki's own handle");
    assert.ok(!sent.rawPath.includes("/sources/wiki/"), "a raw slash would address a different source");
  });

  test("a row for ANOTHER Stack does not gate this one: the gate is (document, Stack)", async () => {
    const otherStack = freshStack("otherstack");
    const stackId = freshStack("thissstack");
    const documentId = await upload(INGESTED_BYTES);
    await record(documentId, otherStack);

    const res = await retract(documentId, { stackId, upstream: false });

    assert.equal(res.status, 409);
    assert.equal((res.body as { error: string }).error, "document_not_ingested");
    assert.deepEqual(await rows(documentId), [{ stack_id: otherStack, last_status: "requested" }]);
  });
});
