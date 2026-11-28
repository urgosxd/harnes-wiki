import { randomBytes, randomUUID } from "node:crypto";
import type { Database } from "./pool.ts";

/**
 * @file src/db/document-store.ts
 * @description Uploaded documents and the link between one document and one
 * ingest job.
 *
 * ## The shape of the problem
 *
 * The ingest service understands REFERENCES, not uploads: a URL it can fetch, or a
 * path it can read. There is no endpoint that accepts bytes. So an upload has to
 * become an addressable resource before it can be ingested at all.
 *
 * That is the entire reason this store exists, and it explains the one unusual
 * decision below: {@link DocumentRecord} carries a `secret`.
 *
 * ## Why a secret per document
 *
 * The URL this server hands out is fetched by the ingest service, which holds no
 * credential. Asking it for one is not an option, so the URL must authorise
 * itself: holding the link is enough to read the bytes.
 *
 * A signed URL would need a signing key to store and rotate. A random secret per
 * row needs neither, and revoking it is `DELETE`. Crucially it is kept SEPARATE
 * from the id, so an id can appear in a log or a UI without leaking the bytes.
 *
 * ## What is deliberately NOT here
 *
 * No `ingested` boolean. Whether a document reached the wiki is a property of the
 * job, which the external service owns; a flag here would be a second, drifting
 * source of truth. {@link ingestFor} records only what we asked for and what we
 * last saw, and says so.
 */

/** A document, without its bytes. Every listing uses this shape. */
export interface DocumentRecord {
  id: string;
  userId: string;
  filename: string;
  contentType: string;
  bytes: number;
  /** Capability half of the URL. Never present in a listing. */
  secret: string;
  createdAt: Date;
}

/** A document with its bytes, for the route that serves them. */
export interface DocumentWithContent extends DocumentRecord {
  content: Buffer;
}

/**
 * What we asked the ingest service to do for one document IN ONE STACK, and what we
 * last saw.
 *
 * The Stack is part of the identity, not an attribute beside it: each Stack compiles
 * and can be retracted independently, so a document holds one state per Stack and no
 * lookup can be answered without saying which one it is about.
 */
export interface DocumentIngest {
  documentId: string;
  stackId: string;
  userId: string;
  jobId: string | null;
  /** Last state we SAW, informational only. Never a live status. */
  lastStatus: string;
  /**
   * When this state was FIRST requested. Left untouched by a re-ingest on purpose, so
   * a caller can tell a long-lived state from one created a second ago; `updated_at`
   * is the field that moves.
   */
  requestedAt: Date;
  updatedAt: Date;
}

interface DocumentRow {
  id: string;
  user_id: string;
  filename: string;
  content_type: string;
  bytes: number;
  secret: string;
  created_at: Date;
}

interface DocumentContentRow extends DocumentRow {
  content: Buffer;
}

interface IngestRow {
  document_id: string;
  stack_id: string;
  user_id: string;
  job_id: string | null;
  last_status: string;
  requested_at: Date;
  updated_at: Date;
}

/** 32 bytes of entropy: guessing it is not a strategy, so it authorises the read. */
const SECRET_BYTES = 32;

/**
 * Strip anything that could change the served path.
 *
 * The filename ends up in a URL that the ingest service fetches, and its extension
 * decides how the bytes are parsed, so this is not cosmetic cleaning: it is what
 * keeps the extension intact and the path a single segment. A name that is empty
 * after cleaning is refused rather than defaulted, because a default would hide a
 * client bug behind a document nobody can later identify.
 */
export function sanitizeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 200);
  if (cleaned.length === 0) {
    throw new Error("a document needs a filename: it decides how the file is parsed");
  }
  return cleaned;
}

function toRecord(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    userId: row.user_id,
    filename: row.filename,
    contentType: row.content_type,
    bytes: row.bytes,
    secret: row.secret,
    createdAt: row.created_at,
  };
}

function toIngest(row: IngestRow): DocumentIngest {
  return {
    documentId: row.document_id,
    stackId: row.stack_id,
    userId: row.user_id,
    jobId: row.job_id,
    lastStatus: row.last_status,
    requestedAt: row.requested_at,
    updatedAt: row.updated_at,
  };
}

export class DocumentStore {
  // A field, not a constructor parameter property: node's strip-only TypeScript
  // support rejects `constructor(private x: T)`.
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Store a new document and mint its capability secret.
   *
   * Two uploads of the same bytes are two documents. Deduplicating by hash would
   * save the bytes and cost a delete that silently breaks another user's job, so
   * identity is per upload on purpose.
   */
  async create(input: {
    userId: string;
    filename: string;
    contentType: string;
    content: Buffer;
  }): Promise<DocumentRecord> {
    const id = randomUUID();
    const secret = randomBytes(SECRET_BYTES).toString("base64url");
    const rows = await this.db.query<DocumentRow>(
      `INSERT INTO documents (id, user_id, filename, content_type, bytes, secret, content)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, user_id, filename, content_type, bytes, secret, created_at`,
      [
        id,
        input.userId,
        sanitizeFilename(input.filename),
        input.contentType,
        input.content.length,
        secret,
        input.content,
      ],
    );
    return toRecord(rows[0]!);
  }

  /** One user's documents, newest first. The upload list. */
  async listForUser(userId: string): Promise<DocumentRecord[]> {
    const rows = await this.db.query<DocumentRow>(
      `SELECT id, user_id, filename, content_type, bytes, secret, created_at
         FROM documents
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [userId],
    );
    return rows.map(toRecord);
  }

  /** One document the user owns, or undefined. A foreign document is not found. */
  async findOwned(id: string, userId: string): Promise<DocumentRecord | undefined> {
    const rows = await this.db.query<DocumentRow>(
      `SELECT id, user_id, filename, content_type, bytes, secret, created_at
         FROM documents
        WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    const row = rows[0];
    return row ? toRecord(row) : undefined;
  }

  /**
   * Resolve a capability URL: id plus secret, NO user.
   *
   * This is the only read that skips ownership, and it is safe for one reason: the
   * caller must already hold the secret, which only ever left this server inside
   * the URL handed to the ingest service. A wrong secret and an unknown id are
   * reported identically so the pair cannot be probed one half at a time.
   */
  async findByCapability(id: string, secret: string): Promise<DocumentWithContent | undefined> {
    const rows = await this.db.query<DocumentContentRow>(
      `SELECT id, user_id, filename, content_type, bytes, secret, created_at, content
         FROM documents
        WHERE id = $1 AND secret = $2`,
      [id, secret],
    );
    const row = rows[0];
    if (!row) return undefined;
    return { ...toRecord(row), content: row.content };
  }

  async delete(id: string, userId: string): Promise<boolean> {
    const rows = await this.db.query<{ id: string }>(
      "DELETE FROM documents WHERE id = $1 AND user_id = $2 RETURNING id",
      [id, userId],
    );
    return rows.length > 0;
  }

  // ---------------------------------------------------------------------------
  // The document -> job link
  // ---------------------------------------------------------------------------

  /**
   * Record that a job was requested for a document, in one Stack.
   *
   * Upsert, not insert: re-ingesting the same document is a supported action (a
   * compile failed, the source was fixed, the Stack was retracted), and the row must
   * reflect the LATEST request rather than accumulate history nobody reads.
   *
   * The conflict target is the COMPOSITE key `(document_id, stack_id)`. It is written
   * out rather than left implicit for a reason: it used to name `(document_id)` alone,
   * from before one document could hold one state per Stack, and a conflict target that
   * names a constraint Postgres no longer has raises instead of upserting. A re-ingest
   * therefore failed at the exact moment it was supposed to record a second attempt.
   *
   * `last_status` is RESET to what the caller passes, not merged with what it held: a
   * retracted Stack that is ingested again is live again, with no tombstone left behind.
   * Changing it back is the whole of the reversibility the feature promises, and it is
   * why this is an assignment rather than a `COALESCE`.
   *
   * `requested_at` deliberately keeps the FIRST request: it answers "how long has this
   * document been tracked in this Stack", which a reset would erase. The latest touch is
   * `updated_at`.
   */
  async recordIngest(input: {
    documentId: string;
    stackId: string;
    userId: string;
    jobId: string | null;
    status: string;
  }): Promise<DocumentIngest> {
    const rows = await this.db.query<IngestRow>(
      `INSERT INTO document_ingests (document_id, stack_id, user_id, job_id, last_status)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (document_id, stack_id) DO UPDATE
         SET job_id = excluded.job_id,
             last_status = excluded.last_status,
             updated_at = now()
       RETURNING *`,
      [input.documentId, input.stackId, input.userId, input.jobId, input.status],
    );
    return toIngest(rows[0]!);
  }

  /**
   * What we last asked for, for one document the user owns IN ONE STACK.
   *
   * The Stack is required, not optional-with-a-default. A document with two states has
   * no "the" row to fall back to: returning the first match would hand Stack B's caller
   * Stack A's job id, and a caller that then retracted or guarded on it would act on a
   * different tenant's compile.
   */
  async ingestFor(
    documentId: string,
    userId: string,
    stackId: string,
  ): Promise<DocumentIngest | undefined> {
    const rows = await this.db.query<IngestRow>(
      "SELECT * FROM document_ingests WHERE document_id = $1 AND user_id = $2 AND stack_id = $3",
      [documentId, userId, stackId],
    );
    const row = rows[0];
    return row ? toIngest(row) : undefined;
  }
}
