/**
 * @file src/api/document-routes.ts
 * @description Uploads, and the capability URL the ingest service fetches.
 *
 * ## Why uploads exist at all
 *
 * The ingest service understands REFERENCES, not bytes: a URL it can fetch or a
 * path it can read. There is no endpoint that takes an upload, and its own MCP tool
 * says the same (`source: URL or absolute path`). So a browser upload cannot reach
 * it directly — the bytes need an address first.
 *
 * This module is that address, and nothing more. It does not parse, convert or
 * summarize: the service does that, better, and closer to its own format rules.
 *
 * ## The two halves, and why they authenticate differently
 *
 * `POST /documents` is an ordinary authenticated write: a user stores a file.
 *
 * `GET /documents/:id/:secret/:filename` CANNOT be authenticated. The caller is the
 * ingest service, which holds no credential of ours, so the URL has to carry its
 * own authorisation. The id alone is not enough (it is guessable-ish and appears in
 * UIs); the 32-byte secret is what makes holding the link equivalent to permission.
 * That is a deliberate, narrow exception, and the only one in this router.
 *
 * ## Why the filename is in the path
 *
 * The service routes by FILE EXTENSION, not by content type:
 *
 *   extname === ".pdf"      -> pdf adapter
 *   IMAGE_EXTENSIONS        -> image adapter
 *   otherwise (not a URL)   -> "file" adapter
 *   starts with http(s)     -> web adapter, which parses HTML
 *
 * A PDF served at a path without `.pdf` is therefore fetched as a WEB PAGE and dies
 * in the HTML extraction step. The extension is part of the wire contract, so the
 * filename travels in the path, and a header alone would not be enough.
 */

import type { Router } from "../http/router.ts";
import { HttpError, sendJson } from "../http/router.ts";
import type { DocumentStore } from "../db/document-store.ts";
import { sanitizeFilename } from "../db/document-store.ts";

/**
 * Upload ceiling: 25 MB.
 *
 * Not an arbitrary number. The ingest service truncates a source to 100,000
 * characters of extracted text, so a much larger upload buys nothing but memory:
 * `readJsonBody` buffers the whole body before this code ever sees it. 25 MB
 * comfortably holds a long PDF or a large image while keeping that buffer bounded.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface DocumentRouteDeps {
  documents: DocumentStore;
  /**
   * Absolute origin this server is reachable at FROM the ingest service, e.g.
   * `http://server:8080`. Needed because the capability URL is handed to another
   * container: a relative path would be meaningless to it, and reusing the
   * browser's origin would be the wrong name entirely.
   *
   * `undefined` disables uploads-with-ingest: without a reachable base there is no
   * URL to hand over, and pretending otherwise would create documents the service
   * can never read.
   */
  publicBaseUrl: string | undefined;
}

/** The path the ingest service will fetch. Exported so the ingest route reuses it. */
export function capabilityPath(document: { id: string; secret: string; filename: string }): string {
  return `/documents/${document.id}/${document.secret}/${encodeURIComponent(document.filename)}`;
}

export function registerDocumentRoutes(router: Router, deps: DocumentRouteDeps): void {
  const { documents } = deps;

  /**
   * Store one document. The body is the raw bytes; the filename is a query
   * parameter because it decides parsing and must survive transport unambiguously.
   */
  router.post("/documents", async (ctx) => {
    const filename = ctx.url.searchParams.get("filename")?.trim();
    if (!filename) {
      throw new HttpError(
        400,
        "filename_required",
        "a filename is required (?filename=...): its extension decides how the file is parsed",
      );
    }

    // Reject an unusable size BEFORE buffering the body. A missing length is not a
    // refusal: chunked bodies are legal, and the router's own limit still applies.
    const declared = ctx.req.headers["content-length"];
    const length = typeof declared === "string" ? Number(declared) : Number.NaN;
    if (Number.isFinite(length) && length > MAX_UPLOAD_BYTES) {
      throw new HttpError(
        413,
        "document_too_large",
        `a document may be at most ${MAX_UPLOAD_BYTES} bytes`,
      );
    }

    const content = await ctx.bodyBytes(MAX_UPLOAD_BYTES);
    if (content.length === 0) {
      throw new HttpError(400, "empty_document", "the request body carried no bytes");
    }

    const header = ctx.req.headers["content-type"];
    const contentType =
      typeof header === "string" && header.trim() ? header.split(";")[0]!.trim() : "application/octet-stream";

    let stored;
    try {
      stored = await documents.create({ userId: ctx.userId, filename, contentType, content });
    } catch (error) {
      // sanitizeFilename refuses a name that cleans away to nothing.
      throw new HttpError(400, "invalid_filename", error instanceof Error ? error.message : String(error));
    }

    sendJson(ctx.res, 201, {
      id: stored.id,
      filename: stored.filename,
      bytes: stored.bytes,
      contentType: stored.contentType,
      createdAt: stored.createdAt,
      // The full URL is returned so a caller never has to build it, and so the one
      // place that knows it is this module.
      ...(deps.publicBaseUrl ? { url: `${deps.publicBaseUrl}${capabilityPath(stored)}` } : {}),
    });
  });

  /** One user's documents, newest first. Never includes a secret. */
  router.get("/documents", async (ctx) => {
    const list = await documents.listForUser(ctx.userId);
    sendJson(ctx.res, 200, {
      documents: list.map((document) => ({
        id: document.id,
        filename: document.filename,
        bytes: document.bytes,
        contentType: document.contentType,
        createdAt: document.createdAt,
      })),
    });
  });

  /**
   * Serve the bytes at a capability URL. NO identity check, by design — see the
   * file overview. A wrong secret and an unknown id answer identically so the pair
   * cannot be probed one half at a time.
   */
  router.get("/documents/:id/:secret/:filename", async (ctx) => {
    const found = await documents.findByCapability(ctx.params.id ?? "", ctx.params.secret ?? "");
    if (!found) throw new HttpError(404, "not_found", "no such document");

    // Serve the STORED name, not the requested one: the URL is only a handle, and
    // trusting its last segment would let a caller relabel the content type of
    // bytes the ingest service is about to parse.
    ctx.res.writeHead(200, {
      "content-type": found.contentType,
      "content-length": found.content.length,
      // Another container fetches this; a cached copy would let a deleted document
      // keep being read.
      "cache-control": "no-store",
      "content-disposition": `inline; filename="${sanitizeFilename(found.filename)}"`,
    });
    ctx.res.end(found.content);
  });

  router.delete("/documents/:id", async (ctx) => {
    const removed = await documents.delete(ctx.params.id ?? "", ctx.userId);
    if (!removed) throw new HttpError(404, "not_found", "no such document");
    ctx.res.writeHead(204);
    ctx.res.end();
  });
}
