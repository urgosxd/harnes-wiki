/**
 * @file src/api/document-ingest-state.ts
 * @description The ONE place that answers "are these bytes the bytes the wiki compiled?"
 *
 * ## Why this is a comparison and not a flag
 *
 * A stored boolean would say "ingested" until something remembered to clear it, and
 * nothing ever would: the file can be replaced and the flag would keep claiming a
 * compile of bytes the wiki never saw. The wiki publishes a `source_hash` per source it
 * compiled, so the mark is the answer to an equality between our `documents.content_hash`
 * and one of those rows — and it drops by itself the moment the file changes.
 *
 * That equality lives in {@link matchingWikiSource} and nowhere else. Changing what
 * identifies "the same content" (a normalised hash, a size-and-hash pair, a different
 * upstream field) is therefore one local edit instead of a search for every comparison.
 *
 * ## The three answers, and why "no data" is not a fourth kind of "no"
 *
 * `current: true` — the wiki holds exactly these bytes.
 * `current: false` — the wiki answered, and does not.
 * `known: false` with NO `current` KEY — the wiki could not be read.
 *
 * The third is not a detail of wording: a UI told `current: false` renders "not
 * ingested", which is a statement about the user's data that nothing verified. Omitting
 * the key makes that mistake impossible to write by accident, so the field is built
 * conditionally rather than set to `null`.
 *
 * ## Why the listing is cached per Stack
 *
 * The panel asks once per document, and the wiki answers once per STACK. Reading it per
 * document would turn opening one page into N calls to another service for a single
 * identical answer. {@link WIKI_DOCUMENTS_TTL_MS} bounds how stale that answer may be,
 * which is the whole risk of caching here: a mark that lags behind a compile by a few
 * seconds is invisible, a mark frozen until restart is a lie.
 *
 * A FAILURE IS NEVER CACHED AS SUCCESS. An unreadable answer is not stored at all, so
 * the next request asks again instead of inheriting a fault; and a cached success that
 * has expired is dropped before a failed re-read can leave it standing.
 */

import type { DocumentIngest } from "../db/document-store.ts";
import type { UpstreamResponse } from "../ingest/client.ts";

/**
 * How long one Stack's wiki listing is reused before it is read again.
 *
 * Five seconds: shorter than a human refresh, long enough that one page's worth of
 * documents costs one upstream call, and short enough that a compile finishing now is
 * visible without a reload trick.
 */
export const WIKI_DOCUMENTS_TTL_MS = 5_000;

/** One source the wiki holds, reduced to what the mark and its two datetimes need. */
export interface WikiSourceRow {
  /** The wiki's identity for the compiled content: plain hex, comparable to ours. */
  sourceHash: string;
  /** When the wiki compiled it, verbatim as reported. Not a date we invented. */
  ingestedAt: string | null;
  /**
   * The wiki's own handle for the source. Not used by the mark; carried because it is
   * the identity a retraction addresses, and reading it here keeps that knowledge in
   * one place instead of a second listing call later.
   */
  storagePath: string | null;
}

/** The one wiki call this module needs, so it can be given a client or a stand-in. */
export interface WikiDocumentsClient {
  listStackDocuments(stackId: string): Promise<UpstreamResponse>;
}

/** The one store call this module needs: our own record for one document in one Stack. */
export interface IngestStateStore {
  ingestFor(documentId: string, userId: string, stackId: string): Promise<DocumentIngest | undefined>;
}

/** What the API says about one document in one Stack. */
export interface DocumentIngestStateView {
  jobId: string | null;
  /** When the ingest was FIRST requested. Our row owns this; the wiki does not. */
  requestedAt: string;
  /** When the wiki compiled these exact bytes, or null when nothing matched. */
  ingestedAt: string | null;
  /** Whether the wiki answered at all. */
  known: boolean;
  /**
   * Present ONLY when `known` is true. An absent key means "no data", which a client
   * must render differently from a `false`.
   */
  current?: boolean;
}

/** Keys a collection may arrive under. Read tolerant, because the envelope is not ours. */
const COLLECTION_KEYS = ["documents", "sources", "items", "data"] as const;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Read the wiki's listing into rows, tolerantly.
 *
 * The envelope belongs to the other service: it may be a bare array, or an object that
 * carries the collection under one of a few plausible keys. What is NOT tolerant is the
 * per-row identity — a row with no `source_hash` cannot identify content, so it is
 * dropped rather than matched against everything. An unrecognisable body is `undefined`
 * (unreadable) and never an empty list: `[]` would mean "the wiki holds nothing", which
 * is a much stronger claim than "I did not understand the answer".
 *
 * Both spellings of each field are read. A rename on the upstream side should be a local
 * change here, not a silent `current: false` for every document.
 */
export function readWikiRows(body: unknown): WikiSourceRow[] | undefined {
  let entries: unknown[] | undefined;
  if (Array.isArray(body)) {
    entries = body;
  } else if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    for (const key of COLLECTION_KEYS) {
      const candidate = record[key];
      if (Array.isArray(candidate)) {
        entries = candidate;
        break;
      }
    }
  }
  if (!entries) return undefined;

  const rows: WikiSourceRow[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const sourceHash = text(record.source_hash) ?? text(record.sourceHash);
    if (!sourceHash) continue;
    rows.push({
      sourceHash,
      ingestedAt: text(record.ingested_at) ?? text(record.ingestedAt) ?? null,
      storagePath: text(record.storage_path) ?? text(record.storagePath) ?? null,
    });
  }
  return rows;
}

/**
 * THE comparison: the wiki row that holds exactly this content, if any.
 *
 * One function, so "what counts as the same content" can change in one place. Comparing
 * case-insensitively costs nothing and removes a whole class of false negative: both
 * sides are hex, and hex has no meaningful case.
 *
 * A NULL or blank hash never matches. That is a legacy row uploaded before hashing
 * existed: there is nothing to compare, and "nothing to compare" is not a match.
 */
export function matchingWikiSource(
  contentHash: string | null | undefined,
  rows: readonly WikiSourceRow[],
): WikiSourceRow | undefined {
  const wanted = text(contentHash ?? undefined)?.toLowerCase();
  if (!wanted) return undefined;
  return rows.find((row) => row.sourceHash.toLowerCase() === wanted);
}

/**
 * The ingest state of documents in one Stack, with the Stack's wiki listing cached.
 *
 * The cache is keyed by Stack and shared across users on purpose: the listing is a
 * property of the Stack, not of whoever is looking, and the wiki answers the same thing
 * to both. Nothing user-specific is stored here.
 */
export class DocumentIngestState {
  private readonly ingest: WikiDocumentsClient;
  private readonly ingests: IngestStateStore;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, { rows: WikiSourceRow[]; expiresAt: number }>();

  constructor(options: {
    ingest: WikiDocumentsClient;
    ingests: IngestStateStore;
    /** Injection seam for tests. Production uses {@link WIKI_DOCUMENTS_TTL_MS}. */
    ttlMs?: number;
    /** Injection seam for tests. */
    now?: () => number;
  }) {
    this.ingest = options.ingest;
    this.ingests = options.ingests;
    this.ttlMs = options.ttlMs ?? WIKI_DOCUMENTS_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * The state of one document, or `null` when there is nothing to describe.
   *
   * `null` has exactly two causes and both are honest: the request named no Stack (the
   * listing is not Stack-scoped, so the state is not either), or we never asked the wiki
   * for these bytes in this Stack. Neither is a refusal, and neither talks to the wiki.
   */
  async forDocument(input: {
    documentId: string;
    contentHash: string | null;
    userId: string;
    stackId: string | undefined;
  }): Promise<DocumentIngestStateView | null> {
    const stackId = input.stackId?.trim();
    if (!stackId) return null;

    const recorded = await this.ingests.ingestFor(input.documentId, input.userId, stackId);
    if (!recorded) return null;

    const base = {
      jobId: recorded.jobId,
      requestedAt: recorded.requestedAt.toISOString(),
    };

    const rows = await this.wikiRows(stackId);
    if (!rows) {
      // No `current` key: the answer is unknown, not negative.
      return { ...base, ingestedAt: null, known: false };
    }

    const matched = matchingWikiSource(input.contentHash, rows);
    return {
      ...base,
      ingestedAt: matched?.ingestedAt ?? null,
      current: matched !== undefined,
      known: true,
    };
  }

  /** Drop one Stack's cached listing, or all of them. */
  forget(stackId?: string): void {
    if (stackId === undefined) this.cache.clear();
    else this.cache.delete(stackId);
  }

  /**
   * The Stack's wiki listing, or `undefined` when it could not be read.
   *
   * `undefined` (not `[]`) is the failure signal, and it is never cached: storing a
   * failure would make the next request inherit a fault it could have recovered from.
   */
  private async wikiRows(stackId: string): Promise<WikiSourceRow[] | undefined> {
    const cached = this.cache.get(stackId);
    if (cached && cached.expiresAt > this.now()) return cached.rows;

    let rows: WikiSourceRow[] | undefined;
    try {
      const response = await this.ingest.listStackDocuments(stackId);
      // Only a 200 is a statement about content. Every other status is the service
      // saying it could not answer, which is not the same as an empty Stack.
      if (response.status === 200) rows = readWikiRows(response.body);
    } catch {
      // Unreachable and timed out arrive here as a thrown error. Both are "cannot read".
      rows = undefined;
    }

    if (!rows) {
      this.cache.delete(stackId);
      return undefined;
    }
    this.cache.set(stackId, { rows, expiresAt: this.now() + this.ttlMs });
    return rows;
  }
}
