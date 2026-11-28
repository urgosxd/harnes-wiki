import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { createDatabase, type Database } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { DocumentStore } from "../src/db/document-store.ts";
import { registerDocumentRoutes } from "../src/api/document-routes.ts";
import { DocumentIngestState, WIKI_DOCUMENTS_TTL_MS } from "../src/api/document-ingest-state.ts";
import { IngestClient } from "../src/ingest/client.ts";
import { createRouter } from "../src/http/router.ts";
import { createAuthenticator } from "../src/http/auth.ts";
import { databaseReady, testUser } from "./support/harness.ts";

/**
 * WHY THIS TEST EXISTS
 *
 * The panel's "ingested" check is not a stored flag. It is the answer to a COMPARISON
 * between the bytes we hold and the source the wiki compiled, and four ways of getting
 * it wrong are invisible on screen:
 *
 *  1. A mark that says "ingested" while the file has already changed. The comparison
 *     against the wiki's `source_hash` is what makes the mark drop by itself, so the
 *     equality and the inequality both have to be pinned.
 *  2. A mark that says "not ingested" when the wiki simply could not be read. That is a
 *     lie about the user's data. An unreadable upstream answers `known: false` and the
 *     `current` key is ABSENT — never `false`.
 *  3. One wiki request per document. The listing carries N rows, and a per-row fetch
 *     turns opening a page into a burst against another service.
 *  4. A listing that refuses to answer at all when no Stack is named. Listing documents
 *     is not Stack-scoped; only the ingest state is, so the documents must still be
 *     listed, each with `ingest: null`, and the upstream must not be called.
 *
 * The wiki is stubbed at the TRANSPORT (a real HTTP server answering the real route),
 * never at the client class: the URL the adapter builds and the envelope it reads back
 * are part of what this file proves.
 */

const USER = testUser("ingest-state");
const TOKEN = "test-token-value-1234";
const headers = { "x-dev-token": TOKEN, "x-user-id": USER };

/**
 * The wiki's `GET /stacks/:stackId/documents` answer.
 *
 * ## PROVENANCE: ASSUMED, NOT RECORDED. This is the one assumption in this file.
 *
 * Nobody has read the upstream's own contract from inside this project. The envelope
 * below — one object with a `documents` array of `source_hash` / `ingested_at` /
 * `storage_path` rows — is DERIVED from the collection convention the same service uses
 * on its job listing (`{ jobs: [...] }`), not observed. The wiki was not running when
 * this landed (only its database container), so there was nothing to probe either.
 *
 * The exact source that would settle it, in one read:
 *   /home/urgosxd/Desktop/ofk/llm-wiki-compiler/docs/guides/http-ingest-jobs.mdx
 *
 * It is NOT read here because it lives outside this project's root and needs the human's
 * grant. Close this in S5, where the real listing is addressed again for the retraction
 * identity, and replace this fixture with the recorded body.
 *
 * Until then the reader is deliberately tolerant — a bare array, and the collection under
 * `documents` / `sources` / `items` / `data`, each field in snake or camel case — and an
 * envelope it does not RECOGNISE fails closed to "no data" (see the unrecognised-envelope
 * test), so a wrong guess shows up as `known: false` and never as "not ingested".
 */
interface WikiRow {
  source_hash: string;
  ingested_at: string | null;
  storage_path: string;
}

const wikiAnswerFor = (stackId: string, rows: WikiRow[]) => ({
  stackId,
  documents: rows,
});

/** The bytes one upload holds, and the digest the wiki would have published for them. */
const INGESTED_BYTES = Buffer.from("%PDF-1.4 recorded content");
const INGESTED_HASH = createHash("sha256").update(INGESTED_BYTES).digest("hex");

/**
 * sha256("abc"), the NIST vector.
 *
 * A hardcoded digest and not one computed in-test: the point of the assertion is that
 * the value stored is the documented sha256 of the stored bytes, in plain lowercase hex,
 * comparable byte for byte with a wiki `source_hash`. Computing the expectation with the
 * same function would pass just as happily if both sides were wrong.
 */
const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

type WikiAnswer = { status: number; body: unknown } | "explode";

const canRun = await databaseReady();
const skip = canRun ? false : "needs Postgres";

describe("GET /documents carries the ingest state, current by content hash", { skip }, () => {
  let db: Database;
  let store: DocumentStore;
  let server: Server;
  let baseUrl: string;
  let upstream: Server;
  /** What the wiki answers per Stack, and how many times it was asked. */
  let wikiAnswers = new Map<string, WikiAnswer>();
  let wikiCalls: string[] = [];

  before(async () => {
    db = createDatabase(
      process.env.DATABASE_URL ?? "postgres://agentdocumentor:agentdocumentor@127.0.0.1:5432/agentdocumentor",
    );
    await migrate(db);
    store = new DocumentStore(db);

    upstream = createServer(async (req, res) => {
      for await (const _chunk of req) void _chunk;
      const match = /^\/stacks\/([^/]+)\/documents$/.exec(req.url ?? "");
      if (!match) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "not_found" } }));
        return;
      }
      const stackId = decodeURIComponent(match[1]!);
      wikiCalls.push(stackId);
      const answer = wikiAnswers.get(stackId) ?? { status: 200, body: wikiAnswerFor(stackId, []) };
      if (answer === "explode") {
        // A connection that dies without an answer: the transport failure the adapter
        // reports as unreachable, which is NOT one of the service's HTTP answers.
        res.destroy();
        return;
      }
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

    const ingest = new IngestClient({ baseUrl: upstreamBase, timeoutMs: 2000 });
    const router = createRouter({ authenticate: createAuthenticator({ users: `${USER}:${TOKEN}` }) });
    registerDocumentRoutes(router, {
      documents: store,
      publicBaseUrl: "http://agentdoc-server:8080",
      ingestState: new DocumentIngestState({ ingest, ingests: store }),
    });
    server = await router.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    // Every row this file wrote hangs off a document it created, and the foreign key
    // cascades, so removing the documents restores the shared database.
    await db?.query("DELETE FROM documents WHERE user_id = $1", [USER]);
    server?.close();
    if (upstream) await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await db?.close();
  });

  /** A Stack nobody else used, so no cached listing can answer for another test. */
  const freshStack = (label: string) => `stack-${label}-${randomUUID().slice(0, 8)}`;

  const upload = async (content: Buffer, filename = "informe.pdf"): Promise<string> => {
    const res = await fetch(`${baseUrl}/documents?filename=${encodeURIComponent(filename)}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/pdf" },
      body: content,
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { id: string };
    return body.id;
  };

  const record = async (documentId: string, stackId: string, jobId = "job_recorded") =>
    store.recordIngest({ documentId, stackId, userId: USER, jobId, status: "requested" });

  interface ListedIngest {
    jobId?: string | null;
    requestedAt?: string;
    ingestedAt?: string | null;
    current?: boolean;
    known?: boolean;
  }

  interface ListedDocument {
    id: string;
    filename?: string;
    bytes?: number;
    contentType?: string;
    createdAt?: string;
    contentHash?: string | null;
    ingest?: ListedIngest | null;
  }

  /** The whole listing, as the browser sees it. */
  const list = async (stackId?: string): Promise<{ status: number; documents: ListedDocument[] }> => {
    const res = await fetch(`${baseUrl}/documents`, {
      headers: stackId === undefined ? headers : { ...headers, "x-stack-id": stackId },
    });
    const body = (await res.json()) as { documents: ListedDocument[] };
    return { status: res.status, documents: body.documents };
  };

  /** One document's entry, from a listing made for one Stack. */
  const entryFor = async (documentId: string, stackId?: string): Promise<ListedDocument> => {
    const { documents } = await list(stackId);
    const found = documents.find((document) => document.id === documentId);
    assert.ok(found, "the document must still be listed");
    return found;
  };

  test("a hash the wiki published is CURRENT, and the wiki's own ingested_at is reported", async () => {
    const stackId = freshStack("current");
    const documentId = await upload(INGESTED_BYTES);
    await record(documentId, stackId, "job_current_1");
    wikiAnswers.set(stackId, {
      status: 200,
      body: wikiAnswerFor(stackId, [
        { source_hash: INGESTED_HASH, ingested_at: "2026-09-21T10:00:00.000Z", storage_path: "wiki/sources/informe.md" },
      ]),
    });

    const entry = await entryFor(documentId, stackId);
    assert.equal(entry.contentHash, INGESTED_HASH);
    assert.deepEqual(entry.ingest, {
      jobId: "job_current_1",
      requestedAt: entry.ingest?.requestedAt,
      ingestedAt: "2026-09-21T10:00:00.000Z",
      current: true,
      known: true,
    });
    assert.ok(entry.ingest?.requestedAt, "when we asked is reported from our own row");
  });

  test("different bytes are NOT current, even though the wiki answered", async () => {
    const stackId = freshStack("diff");
    const documentId = await upload(Buffer.from("%PDF-1.4 other content"));
    await record(documentId, stackId);
    wikiAnswers.set(stackId, {
      status: 200,
      body: wikiAnswerFor(stackId, [
        { source_hash: INGESTED_HASH, ingested_at: "2026-09-21T10:00:00.000Z", storage_path: "wiki/sources/otro.md" },
      ]),
    });

    const entry = await entryFor(documentId, stackId);
    // `known: true` is the difference between "the file changed" and "we could not look".
    assert.equal(entry.ingest?.known, true);
    assert.equal(entry.ingest?.current, false);
    assert.equal(entry.ingest?.ingestedAt, null, "no wiki row describes THESE bytes");
  });

  test("a wiki that answers 503 makes the mark UNKNOWN, never 'not ingested'", async () => {
    const stackId = freshStack("down");
    const documentId = await upload(INGESTED_BYTES);
    await record(documentId, stackId);
    wikiAnswers.set(stackId, { status: 503, body: { error: { code: "unavailable" } } });

    const { status, documents } = await list(stackId);
    assert.equal(status, 200, "the listing itself still answers");
    assert.ok(documents.length > 0, "and still carries every document");
    const ingest = documents.find((document) => document.id === documentId)!.ingest!;
    assert.equal(ingest.known, false);
    // Asserted on the parsed body, not on a string: a JSON writer that emitted
    // `"current": null` would pass a substring check and still say the wrong thing.
    assert.equal("current" in ingest, false, "no `current` key at all: no data is not 'not ingested'");
    assert.equal(ingest.jobId, "job_recorded");
  });

  test("a wiki that cannot be reached at all is the same UNKNOWN, not a crash", async () => {
    const stackId = freshStack("explode");
    const documentId = await upload(INGESTED_BYTES);
    await record(documentId, stackId);
    wikiAnswers.set(stackId, "explode");

    const entry = await entryFor(documentId, stackId);
    assert.equal(entry.ingest?.known, false);
    assert.equal("current" in (entry.ingest as object), false);
    assert.equal(entry.ingest?.ingestedAt, null);
  });

  test("an envelope we do not understand is UNKNOWN, never 'not ingested'", async () => {
    // The wiki is somebody else's contract, so it may answer 200 with a shape this file
    // has never seen. The answer must fail CLOSED: `known: false` with no `current` key.
    // Treating an unrecognisable body as an empty Stack instead would mark every document
    // of every user "not ingested" — the exact lie criterion 2 of this file exists to
    // prevent, arriving through the plumbing rather than through the comparison.
    //
    // The fake rows carry THIS document's hash on purpose. A reader that accepted `rows`
    // (now, or any key added later without thought) would answer current: true and this
    // case would fail, which is what stops it from passing vacuously.
    const unrecognisable: unknown[] = [
      { rows: [{ source_hash: INGESTED_HASH, ingested_at: "2026-09-21T10:00:00.000Z", storage_path: "wiki/sources/x.md" }] },
      { ok: true },
    ];

    for (const body of unrecognisable) {
      const stackId = freshStack("unknown-envelope");
      const documentId = await upload(INGESTED_BYTES);
      await record(documentId, stackId, "job_unreadable");
      wikiAnswers.set(stackId, { status: 200, body });

      const entry = await entryFor(documentId, stackId);
      assert.equal(entry.ingest?.known, false, `200 with ${JSON.stringify(body)} cannot be read`);
      assert.equal("current" in (entry.ingest as object), false, "no key: reading it as false would be a claim");
      assert.equal(entry.ingest?.ingestedAt, null);
      assert.equal(entry.ingest?.jobId, "job_unreadable", "our own record still describes the request");
    }
  });

  test("a legacy row with no hash keeps its state but is never CURRENT", async () => {
    // Uploaded before migration 007, so nothing hashed these bytes. NULL means "no
    // mark", which is true; inventing a hash now would claim a wiki check that never ran.
    const stackId = freshStack("legacy");
    const legacyId = randomUUID();
    await db.query(
      `INSERT INTO documents (id, user_id, filename, content_type, bytes, secret, content, content_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)`,
      [legacyId, USER, "legacy.pdf", "application/pdf", 6, "legacy-secret-value", Buffer.from("legacy")],
    );
    await record(legacyId, stackId, "job_legacy_1");
    wikiAnswers.set(stackId, {
      status: 200,
      body: wikiAnswerFor(stackId, [
        { source_hash: INGESTED_HASH, ingested_at: "2026-09-21T10:00:00.000Z", storage_path: "wiki/sources/legacy.md" },
      ]),
    });

    const entry = await entryFor(legacyId, stackId);
    assert.equal(entry.contentHash, null);
    assert.equal(entry.ingest?.jobId, "job_legacy_1", "the row still describes what we asked for");
    assert.equal(entry.ingest?.known, true);
    assert.equal(entry.ingest?.current, false, "nothing to compare is not a match");
    assert.equal(entry.ingest?.ingestedAt, null);
  });

  test("no recorded ingest for this Stack means ingest is null, not an invented state", async () => {
    const stackId = freshStack("norow");
    const documentId = await upload(INGESTED_BYTES);
    wikiAnswers.set(stackId, {
      status: 200,
      body: wikiAnswerFor(stackId, [
        { source_hash: INGESTED_HASH, ingested_at: "2026-09-21T10:00:00.000Z", storage_path: "wiki/sources/x.md" },
      ]),
    });

    const entry = await entryFor(documentId, stackId);
    assert.equal(entry.ingest, null);
  });

  test("no Stack named still lists every document, with no ingest state and no upstream call", async () => {
    const documentId = await upload(INGESTED_BYTES);
    wikiAnswers.clear();
    wikiCalls = [];

    const { status, documents } = await list();
    assert.equal(status, 200, "listing documents is not Stack-scoped, so it must not refuse");
    assert.ok(documents.length > 0);
    for (const document of documents) {
      assert.equal(document.ingest, null);
    }
    assert.ok(documents.some((document) => document.id === documentId));
    assert.deepEqual(wikiCalls, [], "without a Stack there is nothing to ask the wiki about");
  });

  test("the wiki is read ONCE per Stack per window, not once per document", async () => {
    const stackId = freshStack("cache");
    const first = await upload(INGESTED_BYTES);
    const second = await upload(Buffer.from("%PDF-1.4 a second document"));
    await record(first, stackId);
    await record(second, stackId);
    wikiAnswers.set(stackId, {
      status: 200,
      body: wikiAnswerFor(stackId, [
        { source_hash: INGESTED_HASH, ingested_at: "2026-09-21T10:00:00.000Z", storage_path: "wiki/sources/cache.md" },
      ]),
    });
    wikiCalls = [];

    const one = await entryFor(first, stackId);
    assert.equal(one.ingest?.current, true);
    const two = await entryFor(first, stackId);
    assert.equal(two.ingest?.current, true);
    assert.equal(wikiCalls.filter((called) => called === stackId).length, 1, "two listings, one upstream read");

    // Past the window the listing is read again: a cache that never expired would
    // freeze a mark that the wiki has already changed.
    await new Promise((resolve) => setTimeout(resolve, WIKI_DOCUMENTS_TTL_MS + 250));
    await entryFor(first, stackId);
    assert.equal(wikiCalls.filter((called) => called === stackId).length, 2, "after the window, a second read");
  });

  test("an upload stores the sha256 of its bytes, in plain lowercase hex", async () => {
    const documentId = await upload(Buffer.from("abc"), "vector.txt");

    const rows = await db.query<{ content_hash: string | null }>(
      "SELECT content_hash FROM documents WHERE id = $1",
      [documentId],
    );
    assert.equal(rows[0]?.content_hash, ABC_SHA256, "no `sha256:` prefix: it must be byte-comparable");
    // Echoed by the listing, so the browser can show the identity it compares against.
    const entry = await entryFor(documentId);
    assert.equal(entry.contentHash, ABC_SHA256);
  });

  test("the listing's own shape is unchanged: same keys, same values, no secret", async () => {
    const documentId = await upload(Buffer.from("%PDF-1.4 preserved"), "conservado.pdf");

    const entry = await entryFor(documentId);
    // Nothing renamed and nothing removed: these five were the whole contract before
    // this feature added two more fields beside them.
    assert.deepEqual(
      {
        id: entry.id,
        filename: entry.filename,
        bytes: entry.bytes,
        contentType: entry.contentType,
        createdAt: entry.createdAt,
      },
      {
        id: documentId,
        filename: "conservado.pdf",
        bytes: Buffer.byteLength("%PDF-1.4 preserved"),
        contentType: "application/pdf",
        createdAt: entry.createdAt,
      },
    );
    assert.ok(entry.createdAt && !Number.isNaN(Date.parse(entry.createdAt)));
    assert.equal((entry as unknown as Record<string, unknown>).secret, undefined, "a secret in a listing would grant access");
    assert.equal((entry as unknown as Record<string, unknown>).url, undefined);
  });
});
