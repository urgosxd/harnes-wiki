/**
 * @file src/api/document-retraction.ts
 * @description The one path that removes compiled content from the wiki: our `POST
 * /documents/:id/retract`, translated into the wiki's own source deletion.
 *
 * ## What is ours to decide, and what is emphatically not
 *
 * Ours: whether we ever asked for these bytes to be ingested in this Stack (`a
 * document_ingests` row exists), and which wiki source describes them.
 *
 * Not ours: whether the wiki still "holds something". The wiki publishes its own
 * deletion semantics, and a client that asks for a retraction of content that is no
 * longer there is answered by the wiki, not by a local opinion. That is why nothing here
 * reads `ingest.current`: a request whose file changed after the compile is exactly the
 * request an owner makes, and a handler that refused it would be deciding, on the wiki's
 * behalf, that there was nothing to retract.
 *
 * The comparison against `source_hash` below is NOT that decision. It answers a different
 * question — "which of the wiki's sources ARE these bytes?", i.e. the identity a deletion
 * must address — and when it finds nothing there is no identity to send, so the request is
 * refused rather than guessed.
 *
 * ## Why the identity is the wiki's `storage_path`
 *
 * The wiki deletes the file IT stored. Our document id means nothing to it, and the
 * upload's filename is not the name the source landed under. `storage_path`, read from the
 * wiki's own listing, is the only handle that names the thing being deleted, and it travels
 * as ONE encoded path segment (see `IngestClient.deleteSource`).
 *
 * ## The enable flag
 *
 * The upstream deletion is E7, which this deployment cannot assume exists. With
 * `SOURCE_RETRACTION_ENABLED` off, the endpoint answers `503
 * source_retraction_unavailable` naming that variable, before any identity is resolved and
 * without a single upstream call. A disabled deployment must never record a retraction it
 * did not perform.
 */

import { HttpError } from "../http/router.ts";
import type { DocumentIngest } from "../db/document-store.ts";
import { IngestServiceUnreachable, newJobId, type UpstreamResponse } from "../ingest/client.ts";
import {
  matchingWikiSource,
  readWikiRows,
  type WikiSourceRow,
} from "./document-ingest-state.ts";

/**
 * The two wiki calls a retraction needs, and nothing else.
 *
 * Narrower than `IngestClient` on purpose: the retraction must not acquire an opinion
 * about jobs, and a two-method seam is what lets a test count "zero upstream calls"
 * without a network.
 */
export interface RetractionClient {
  listStackDocuments(stackId: string): Promise<UpstreamResponse>;
  deleteSource(stackId: string, identity: string): Promise<UpstreamResponse>;
}

/** The local state a retraction reads and writes. */
export interface RetractionStore {
  /** Our record for one document in one Stack. Its ABSENCE is the only local gate. */
  ingestFor(documentId: string, userId: string, stackId: string): Promise<DocumentIngest | undefined>;
  /** Mark the row retracted once the wiki accepted the deletion. */
  markRetracted(documentId: string, userId: string, stackId: string): Promise<void>;
}

export interface DocumentRetractionOptions {
  /**
   * The wiki adapter, or `undefined` when this deployment consumes no ingest service.
   * Absent is not the same failure as disabled, and the two messages say so.
   */
  client: RetractionClient | undefined;
  ingests: RetractionStore;
  /** `SOURCE_RETRACTION_ENABLED`. Off by default: see the file overview. */
  enabled: boolean;
}

/**
 * The one code for "there was nothing to retract", whether we knew it before the call or
 * the wiki told us so. Two codes for one fact would make every client branch twice.
 */
const NOTHING_TO_RETRACT = "document_not_ingested";

export class DocumentRetraction {
  private readonly client: RetractionClient | undefined;
  private readonly ingests: RetractionStore;
  private readonly enabled: boolean;

  constructor(options: DocumentRetractionOptions) {
    this.client = options.client;
    this.ingests = options.ingests;
    this.enabled = options.enabled;
  }

  /**
   * Retract one document in one Stack, or refuse with the contract's status.
   *
   * Ownership is NOT re-checked here: it is the route's first answer, and doing it twice
   * would put the same decision in two places. What this method owns is the order of the
   * facts it can see — deployment capability, then our own record, then the wiki.
   *
   * @returns the wiki's job id for the deletion-and-recompile it accepted.
   */
  async retract(input: {
    documentId: string;
    userId: string;
    stackId: string;
    /** The stored sha256 of this document's bytes, or null for a pre-hash row. */
    contentHash: string | null;
  }): Promise<{ jobId: string }> {
    const { documentId, userId, stackId } = input;
    const client = this.requireCapability();

    // THE GATE, and the only one. A row means we asked for these bytes in this Stack;
    // nothing about the hash comparison below may turn into a second opinion on it.
    const recorded = await this.ingests.ingestFor(documentId, userId, stackId);
    if (!recorded) {
      throw new HttpError(
        409,
        NOTHING_TO_RETRACT,
        `Document "${documentId}" has no ingest recorded in Stack "${stackId}"; there is nothing to retract`,
      );
    }

    const identity = await this.sourceIdentity(client, stackId, input.contentHash, documentId);
    const answer = await this.deleteSource(client, stackId, identity);

    if (answer.status === 202 || answer.status === 200) {
      const jobId = newJobId(answer.body);
      if (!jobId) {
        // Accepted without the id that proves it: there is no `202 { jobId }` to answer
        // with, and no local state to record on the strength of a body we cannot read.
        throw new HttpError(
          502,
          "ingest_service_error",
          "the ingest service accepted the retraction but answered without a job id",
        );
      }
      // ACCEPTED means the wiki is deleting and recompiling NOW. The row says so from
      // here on, and a re-ingest resets it (`recordIngest`), which is the reversibility.
      await this.ingests.markRetracted(documentId, userId, stackId);
      return { jobId };
    }

    if (answer.status === 404) {
      // The wiki's own "nothing to retract", folded into our one code and carrying the
      // wiki's sentence: it names the source, which ours cannot.
      throw new HttpError(
        409,
        NOTHING_TO_RETRACT,
        upstreamMessage(answer.body) ??
          `Document "${documentId}" has no compiled source in Stack "${stackId}" to retract`,
      );
    }

    if (answer.status === 409) {
      // A mutation for this Stack is in flight upstream. `busy` is a retry signal, and
      // the row is left alone: nothing was retracted.
      throw new HttpError(
        409,
        "busy",
        upstreamMessage(answer.body) ??
          `an ingest or retraction for document "${documentId}" in Stack "${stackId}" is already in flight`,
      );
    }

    // Every other status is the wiki failing, not refusing. `502` matches the vocabulary
    // the ingest routes already answer with: the deployment IS configured, the service
    // just did not do its job.
    throw new HttpError(
      502,
      "ingest_service_error",
      `the ingest service answered ${answer.status} to a source deletion`,
    );
  }

  /**
   * Whether this deployment may delete sources at all, decided before anything else.
   *
   * Two distinct absences, two messages: no adapter at all is a deployment with no ingest
   * service, and a flag turned off is one that has the service but has not been cleared to
   * mutate it. The messages name the variable because the reader is an operator.
   */
  private requireCapability(): RetractionClient {
    const client = this.client;
    if (!client) {
      throw new HttpError(
        503,
        "source_retraction_unavailable",
        "this deployment has no INGEST_API_BASE_URL, so it cannot retract a source: " +
          "SOURCE_RETRACTION_ENABLED alone does not give it one",
      );
    }
    if (!this.enabled) {
      throw new HttpError(
        503,
        "source_retraction_unavailable",
        "source retraction is not enabled in this deployment: set SOURCE_RETRACTION_ENABLED=true " +
          "to let the wiki delete a compiled source and recompile without it",
      );
    }
    return client;
  }

  /**
   * The wiki's identity for OUR bytes in this Stack.
   *
   * Read fresh, from the Stack's listing, with no cache: a retraction is the operation
   * right after a compile, and a listing reused from five seconds ago may not carry the
   * source it has just written. A listing that cannot be read, a body this reader does not
   * recognise, or no row matching our hash all land in the same answer — `503`, no request
   * sent — because the alternative is addressing a source nobody named.
   */
  private async sourceIdentity(
    client: RetractionClient,
    stackId: string,
    contentHash: string | null,
    documentId: string,
  ): Promise<string> {
    let rows: WikiSourceRow[] | undefined;
    try {
      const response = await client.listStackDocuments(stackId);
      // Only a 200 is a statement about what the wiki holds; anything else is it saying
      // it could not answer, which is not an empty Stack.
      if (response.status === 200) rows = readWikiRows(response.body);
    } catch {
      rows = undefined;
    }

    const identity = matchingWikiSource(contentHash, rows ?? [])?.storagePath?.trim();
    if (!identity) {
      throw new HttpError(
        503,
        "source_retraction_unavailable",
        `the wiki lists no source in Stack "${stackId}" that holds the content of document ` +
          `"${documentId}", so there is no source to retract`,
      );
    }
    return identity;
  }

  /** One upstream deletion, with unreachable reported as the failure it is (a `502`). */
  private async deleteSource(
    client: RetractionClient,
    stackId: string,
    identity: string,
  ): Promise<UpstreamResponse> {
    try {
      return await client.deleteSource(stackId, identity);
    } catch (error) {
      if (error instanceof IngestServiceUnreachable) {
        throw new HttpError(502, `ingest_service_${error.reason}`, error.message);
      }
      throw error;
    }
  }
}

/**
 * The wiki's own sentence from an error body, in either spelling.
 *
 * Read rather than reshaped: a body this reader does not understand yields `undefined`,
 * and the caller falls back to a sentence of ours instead of forwarding `[object Object]`.
 */
function upstreamMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as { error?: unknown; message?: unknown };
  if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
  if (typeof record.error === "object" && record.error !== null) {
    const message = (record.error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return undefined;
}
