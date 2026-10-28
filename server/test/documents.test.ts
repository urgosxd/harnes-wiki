import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDatabase, type Database } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { DocumentStore } from "../src/db/document-store.ts";
import { registerDocumentRoutes, capabilityPath, MAX_UPLOAD_BYTES } from "../src/api/document-routes.ts";
import { registerIngestRoutes } from "../src/api/ingest-routes.ts";
import { IngestClient } from "../src/ingest/client.ts";
import { createRouter } from "../src/http/router.ts";
import { createAuthenticator } from "../src/http/auth.ts";
import { databaseReady } from "./support/harness.ts";

/**
 * WHY EACH OF THESE EXISTS
 *
 * Uploading here is not a product nicety: the ingest service cannot accept bytes at
 * all, so a document has to become an address before it can be ingested. Four
 * things break that quietly and are pinned below:
 *
 *  1. The capability URL is fetched by a service with NO credential of ours, so it
 *     must authorise itself — and must not be readable without the secret.
 *  2. The service routes by FILE EXTENSION. A PDF served without `.pdf` is parsed
 *     as a web page, so the extension surviving into the URL is load-bearing.
 *  3. An upload is not an ingest. Both must exist independently, or a failed
 *     compile forces the user to re-upload.
 *  4. The global JSON body limit must not be raised to accommodate uploads.
 */

const USER = "alice";
const TOKEN = "test-token-value-1234";
const headers = {
  "x-dev-token": TOKEN,
  "x-user-id": USER,
  "content-type": "application/pdf",
};

const canRun = databaseReady();
const skip = canRun ? false : "needs Postgres";

describe("documents: storage and the capability URL", { skip }, () => {
  let db: Database;
  let store: DocumentStore;
  let server: Server;
  let baseUrl: string;
  let publicBase: string;

  before(async () => {
    db = createDatabase(
      process.env.DATABASE_URL ?? "postgres://agentdocumentor:agentdocumentor@127.0.0.1:5432/agentdocumentor",
    );
    await migrate(db);
    store = new DocumentStore(db);

    const router = createRouter({ authenticate: createAuthenticator({ users: `${USER}:${TOKEN}` }) });
    // The base the service would use to reach us. The port is not known until
    // listen() resolves, so the registered value is a placeholder that the tests
    // rewrite to the real origin: the SHAPE of the URL is what is under test, not
    // the host.
    publicBase = "http://placeholder";
    registerDocumentRoutes(router, {
      documents: store,
      publicBaseUrl: publicBase,
    });
    server = await router.listen(0, "127.0.0.1");
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    publicBase = baseUrl;
  });

  after(async () => {
    server?.close();
    await db?.close();
  });

  /** The registered URL, moved onto the port this test server actually bound. */
  const reachable = (url: string) => url.replace("http://placeholder", baseUrl);

  const upload = async (filename: string, body: Buffer | string, contentType = "application/pdf") => {
    return fetch(`${baseUrl}/documents?filename=${encodeURIComponent(filename)}`, {
      method: "POST",
      headers: { ...headers, "content-type": contentType },
      body,
    });
  };

  test("stores an upload and answers with its identity, not its bytes", async () => {
    const res = await upload("contrato.pdf", Buffer.from("%PDF-1.4 fake"));
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      id: string;
      filename: string;
      bytes: number;
      url?: string;
    };
    assert.match(body.id, /^[0-9a-f-]{36}$/);
    assert.equal(body.filename, "contrato.pdf");
    assert.equal(body.bytes, Buffer.byteLength("%PDF-1.4 fake"));
    // The URL is handed over ready to use; a caller never builds it itself.
    assert.ok(body.url?.includes(body.id));
    assert.equal((body as Record<string, unknown>).body, undefined, "the bytes must not be echoed back");
  });

  test("the capability URL carries the extension, because it decides parsing", async () => {
    const res = await upload("informe-anual.pdf", Buffer.from("%PDF-1.4 x"));
    const created = (await res.json()) as { id: string; url: string };

    // The service routes on `path.extname`; without `.pdf` it would treat these
    // bytes as HTML and fail in extraction.
    assert.match(created.url, /\.pdf$/);
    assert.match(created.url, new RegExp(`/documents/${created.id}/`));
  });

  test("serves the bytes WITHOUT an identity, because the caller is another service", async () => {
    const res = await upload("sin-auth.pdf", Buffer.from("%PDF-1.4 secret"));
    const created = (await res.json()) as { url: string };

    // No x-dev-token, no x-user-id: exactly what the ingest service can do.
    const fetched = await fetch(reachable(created.url));
    assert.equal(fetched.status, 200);
    assert.equal(fetched.headers.get("content-type"), "application/pdf");
    assert.equal(await fetched.text(), "%PDF-1.4 secret");
    // A cached copy would let a deleted document keep being readable.
    assert.equal(fetched.headers.get("cache-control"), "no-store");
  });

  test("a wrong secret is not found, and looks exactly like an unknown id", async () => {
    const res = await upload("protegido.pdf", Buffer.from("%PDF-1.4 y"));
    const created = (await res.json()) as { id: string; url: string };

    const wrongSecret = reachable(created.url).replace(/\/([^/]+)\/[^/]+$/, "/wrong-secret/protegido.pdf");
    const wrong = await fetch(wrongSecret);
    const unknown = await fetch(`${baseUrl}/documents/00000000-0000-0000-0000-000000000000/whatever/x.pdf`);

    assert.equal(wrong.status, 404);
    assert.equal(unknown.status, 404);
    // Identical answers: the pair cannot be probed one half at a time.
    assert.deepEqual(await wrong.json(), await unknown.json());
  });

  test("the listing never includes a secret", async () => {
    await upload("listado.pdf", Buffer.from("%PDF-1.4 z"));
    const res = await fetch(`${baseUrl}/documents`, { headers });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { documents: Array<Record<string, unknown>> };
    assert.ok(body.documents.length > 0);
    for (const document of body.documents) {
      assert.equal(document.secret, undefined, "a secret in a listing would grant access by listing");
      assert.equal(document.url, undefined);
    }
  });

  test("a foreign document is not found for another user", async () => {
    const res = await upload("ajeno.pdf", Buffer.from("%PDF-1.4 a"));
    const created = (await res.json()) as { id: string };

    // Same router, different identity: bob must not see alice's upload.
    const otherRouter = createRouter({
      authenticate: createAuthenticator({ users: `${USER}:${TOKEN},bob:another-token-123456` }),
    });
    const otherStore = new DocumentStore(db);
    registerDocumentRoutes(otherRouter, { documents: otherStore, publicBaseUrl: publicBase });
    const otherServer = await otherRouter.listen(0, "127.0.0.1");
    const otherBase = `http://127.0.0.1:${(otherServer.address() as AddressInfo).port}`;
    try {
      const list = await fetch(`${otherBase}/documents`, {
        headers: { "x-dev-token": "another-token-123456", "x-user-id": "bob" },
      });
      const body = (await list.json()) as { documents: Array<{ id: string }> };
      assert.equal(
        body.documents.some((d) => d.id === created.id),
        false,
        "another user's document must not be listed",
      );
    } finally {
      otherServer.close();
    }
  });

  test("refuses an upload with no filename, because the name decides parsing", async () => {
    const res = await fetch(`${baseUrl}/documents`, { method: "POST", headers, body: Buffer.from("x") });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "filename_required");
  });

  test("refuses an empty body", async () => {
    const res = await upload("vacio.pdf", Buffer.alloc(0));
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "empty_document");
  });

  test("refuses an oversized upload", async () => {
    // A real body above the ceiling, so the limit is exercised rather than
    // simulated: 25 MB through loopback is fast, and a declared-length-only test
    // would pass even if the streaming guard were missing.
    const tooBig = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x41);
    const res = await upload("grande.pdf", tooBig);
    assert.equal(res.status, 413);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "document_too_large");
  });

  test("an upload larger than the global JSON limit is accepted", async () => {
    // The router's JSON ceiling is 1 MB. An upload above it must still work,
    // because the limit was raised for THIS route only — raising the global default
    // would widen every route for a need one of them has.
    const res = await upload("mediano.pdf", Buffer.alloc(3 * 1024 * 1024, 0x42));
    assert.equal(res.status, 201);
  });

  test("deletes an upload, and the capability URL stops working", async () => {
    const res = await upload("borrable.pdf", Buffer.from("%PDF-1.4 b"));
    const created = (await res.json()) as { id: string; url: string };

    const removed = await fetch(`${baseUrl}/documents/${created.id}`, { method: "DELETE", headers });
    assert.equal(removed.status, 204);
    assert.equal((await fetch(reachable(created.url))).status, 404);
  });
});

describe("ingest from a document reference", { skip }, () => {
  let db: Database;
  let store: DocumentStore;
  let server: Server;
  let baseUrl: string;
  let upstreamSeen: Array<{ url: string; body: unknown }> = [];
  let upstream: Server;

  before(async () => {
    db = createDatabase(
      process.env.DATABASE_URL ?? "postgres://agentdocumentor:agentdocumentor@127.0.0.1:5432/agentdocumentor",
    );
    await migrate(db);
    store = new DocumentStore(db);

    // A stand-in for the ingest service that records what SOURCE it was handed.
    upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const text = Buffer.concat(chunks).toString("utf8");
      upstreamSeen.push({ url: req.url ?? "/", body: text ? JSON.parse(text) : undefined });
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ jobId: "ing_doc_1", status: "queued", stage: "queued" }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

    const router = createRouter({ authenticate: createAuthenticator({ users: `${USER}:${TOKEN}` }) });
    registerDocumentRoutes(router, { documents: store, publicBaseUrl: "http://agentdoc-server:8080" });
    registerIngestRoutes(router, {
      ingest: new IngestClient({ baseUrl: upstreamBase, timeoutMs: 2000 }),
      documents: {
        urlFor: async (documentId, userId) => {
          const found = await store.findOwned(documentId, userId);
          return found ? `http://agentdoc-server:8080${capabilityPath(found)}` : undefined;
        },
      },
    });
    server = await router.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server?.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await db?.close();
  });

  test("a documentId becomes a capability URL, not a path on this container", async () => {
    const uploaded = await fetch(`${baseUrl}/documents?filename=propuesta.pdf`, {
      method: "POST",
      headers,
      body: Buffer.from("%PDF-1.4 p"),
    });
    const created = (await uploaded.json()) as { id: string };

    upstreamSeen = [];
    const res = await fetch(`${baseUrl}/ingest/jobs`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ documentId: created.id }),
    });
    assert.equal(res.status, 202);

    const sent = upstreamSeen.at(-1)?.body as { source?: string; async?: boolean };
    assert.equal(sent.async, true, "async is still forced");
    // The whole point: an address the service can fetch, with the extension that
    // tells it how to parse the bytes.
    assert.equal(sent.source, `http://agentdoc-server:8080/documents/${created.id}/${(await store.findOwned(created.id, USER))!.secret}/propuesta.pdf`);
    assert.match(sent.source!, /\.pdf$/);
  });

  test("a foreign documentId is not found, and no upstream call is made", async () => {
    upstreamSeen = [];
    const res = await fetch(`${baseUrl}/ingest/jobs`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ documentId: "00000000-0000-0000-0000-000000000000" }),
    });
    assert.equal(res.status, 404);
    assert.equal(upstreamSeen.length, 0, "nothing may be sent upstream for a document we refuse");
  });

  test("source and documentId together are refused, not resolved by precedence", async () => {
    upstreamSeen = [];
    const res = await fetch(`${baseUrl}/ingest/jobs`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ source: "https://example.com/a", documentId: "x" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "ambiguous_target");
    assert.equal(upstreamSeen.length, 0);
  });

  test("a plain source still works: uploads are an addition, not a replacement", async () => {
    upstreamSeen = [];
    const res = await fetch(`${baseUrl}/ingest/jobs`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ source: "https://example.com/article" }),
    });
    assert.equal(res.status, 202);
    const sent = upstreamSeen.at(-1)?.body as { source?: string };
    assert.equal(sent.source, "https://example.com/article");
  });
});

describe("no PUBLIC_BASE_URL means no upload-backed ingest", { skip }, () => {
  test("answers 503 with a code that says so, instead of a broken URL", async () => {
    const router = createRouter({ authenticate: createAuthenticator({ users: `${USER}:${TOKEN}` }) });
    registerIngestRoutes(router, {
      ingest: new IngestClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 500 }),
      documents: undefined,
    });
    const server = await router.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${base}/ingest/jobs`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ documentId: "any-id" }),
      });
      assert.equal(res.status, 503);
      const body = (await res.json()) as { error?: string };
      assert.equal(body.error, "documents_not_configured");
    } finally {
      server.close();
    }
  });
});
