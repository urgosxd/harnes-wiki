import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClient, ApiError, type UploadedDocument } from "./api.ts";
import { type IngestJob, type PollOutcome, type PollStopReason } from "./ingest.ts";

/**
 * Owns the ingest-jobs view: the list, the polled job, and the stop notice.
 *
 * ## The tenant is an input, not a choice
 *
 * `stackId` arrives already resolved from the link (see `tenant.ts`) and is used
 * verbatim: the list, the poll and every create carry it, because the service scopes
 * reads by Stack and records writes in the Stack the request names.
 *
 * When the link named no Stack, this hook is BLOCKED: it performs no request at all,
 * not a listing, not a poll, not a create. The honest reason is not performance —
 * a list read with no Stack is not an empty list, it is a read of whatever tenant the
 * endpoint happens to be bound to, which is exactly the coupling this product is
 * removing. `blockedProblem` is what the panel shows instead.
 *
 * ## Three things this hook deliberately does NOT do
 *
 *  - It does not merge the two dimensions into one state. The job object is
 *    passed through exactly as the server returned it.
 *  - It does not invent progress. `progress` reaches the component untouched,
 *    `null` included.
 *  - It does not retry a 404 or a 503. Both are stated outcomes the user must
 *    see; a silent retry would turn "this job expired" into an endless spinner.
 *    The same applies to a Stack the service rejects: the answer is shown once.
 */

export type IngestNotice = {
  /**
   * `unavailable` is 503, `unknown` is 404, `not_configured` is our own 503, and
   * `stalled` is none of them: the job is known and its state is on screen, but it
   * will not advance. Four different facts, four different pieces of advice.
   */
  kind: "unavailable" | "unknown" | "error" | "not_configured" | "stalled";
  message: string;
} | null;

/**
 * What the ingest surface says when the link names no Stack.
 *
 * It names the parameter AND the shape of a working link, because the link is the
 * only fix available: there is nothing to type here and no default to fall back on.
 */
export const MISSING_STACK_ID_PROBLEM =
  "This page needs a stackId in the link. Ingest reads and writes belong to one " +
  "Stack, so without it there is nothing safe to read. Open the link you were " +
  "given, which ends in ?user=<name>&stackId=<stack-id>.";

export interface UseIngestResult {
  /**
   * The tenant Stack, read once from the link and never defaulted or remembered.
   *
   * `null` means the link named none, which blocks every read and write below.
   */
  stackId: string | null;
  /** Why the surface is blocked, or `null` once the link named a Stack. */
  blockedProblem: string | null;

  /** Files this user has uploaded, newest first. Each is a resource, not a job. */
  documents: UploadedDocument[];
  uploading: boolean;
  listDocuments(): Promise<void>;
  upload(file: File): Promise<UploadedDocument | null>;
  removeDocument(id: string): Promise<void>;
  /** Start an ingest for an uploaded document, by reference. */
  ingestDocument(id: string, options?: { compile?: boolean }): Promise<void>;
  /** Set when an upload or listing failed. Distinct from a poll notice. */
  documentsNotice: IngestNotice;

  jobs: IngestJob[];
  activeJob: IngestJob | null;
  activeId: string | null;
  loadingList: boolean;
  listNotice: IngestNotice;
  pollNotice: IngestNotice;
  starting: boolean;
  /** True while the active job is being polled. */
  following: boolean;
  start(source: string, options?: { compile?: boolean }): Promise<void>;
  follow(id: string): void;
  stopFollowing(): void;
  refreshList(): Promise<void>;
  clearPollNotice(): void;
}

export function useIngest({
  client,
  stackId,
}: {
  client: ApiClient;
  /** The tenant, already resolved from the link. `null` blocks the whole surface. */
  stackId: string | null;
}): UseIngestResult {
  // Read once and never mutated: the link is the only source, so there is no
  // selection to track and nothing a later render could contradict.
  const blocked = stackId === null;

  const [documents, setDocuments] = useState<UploadedDocument[]>([]);
  const [uploading, setUploading] = useState(false);
  const [documentsNotice, setDocumentsNotice] = useState<IngestNotice>(null);
  const [jobs, setJobs] = useState<IngestJob[]>([]);
  const [activeJob, setActiveJob] = useState<IngestJob | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Not "true then corrected": with no tenant there is no list to load, and a
  // loading state that never resolves would look like a slow server.
  const [loadingList, setLoadingList] = useState(!blocked);
  const [listNotice, setListNotice] = useState<IngestNotice>(null);
  const [pollNotice, setPollNotice] = useState<IngestNotice>(null);
  const [starting, setStarting] = useState(false);
  const [following, setFollowing] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  const listDocuments = useCallback(async () => {
    if (!stackId) return;
    try {
      setDocuments(await client.listDocuments());
      setDocumentsNotice(null);
    } catch (error) {
      setDocumentsNotice(noticeFor(error));
    }
  }, [client, stackId]);

  useEffect(() => {
    void listDocuments();
  }, [listDocuments]);

  /**
   * Upload one file.
   *
   * An upload does NOT start an ingest. Keeping them apart is the point of the
   * resource having identity: the same document can be ingested again after a
   * failed compile without being uploaded twice, and a user can store a file now
   * and decide later whether it belongs in the wiki.
   */
  const upload = useCallback(
    async (file: File): Promise<UploadedDocument | null> => {
      if (!stackId) return null;
      setUploading(true);
      setDocumentsNotice(null);
      try {
        const stored = await client.uploadDocument(file);
        await listDocuments();
        return stored;
      } catch (error) {
        setDocumentsNotice(noticeFor(error));
        return null;
      } finally {
        setUploading(false);
      }
    },
    [client, listDocuments, stackId],
  );

  const removeDocument = useCallback(
    async (id: string) => {
      if (!stackId) return;
      try {
        await client.deleteDocument(id);
        await listDocuments();
      } catch (error) {
        setDocumentsNotice(noticeFor(error));
      }
    },
    [client, listDocuments, stackId],
  );

  const refreshList = useCallback(async () => {
    if (!stackId) return;
    try {
      const list = await client.listIngestJobs(stackId);
      setJobs(list);
      setListNotice(null);
    } catch (error) {
      setListNotice(noticeFor(error));
    } finally {
      setLoadingList(false);
    }
  }, [client, stackId]);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  // A poll loop outliving the view would keep calling a component that no longer
  // exists; the abort is what actually ends it.
  useEffect(() => () => abortRef.current?.abort(), []);

  const stopFollowing = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setFollowing(false);
  }, []);

  const follow = useCallback(
    (id: string) => {
      // Nothing to follow without a tenant: the read would answer for whichever
      // Stack the endpoint is bound to.
      if (!stackId) return;
      stopFollowing();
      const controller = new AbortController();
      abortRef.current = controller;
      setActiveId(id);
      setFollowing(true);
      setPollNotice(null);

      void client
        .pollIngestJob(id, {
          signal: controller.signal,
          stackId,
          onUpdate: (job) => setActiveJob(job),
        })
        .then((outcome) => {
          if (abortRef.current === controller) {
            abortRef.current = null;
            setFollowing(false);
          }
          setPollNotice(noticeForOutcome(outcome));
          // A settled job changes the list's summary; a failed one may not appear
          // there at all if the list read failed earlier.
          if (outcome.reason === "settled") void refreshList();
        })
        .catch(() => {
          if (abortRef.current === controller) {
            abortRef.current = null;
            setFollowing(false);
          }
        });
    },
    [client, refreshList, stackId, stopFollowing],
  );

  /**
   * Start an ingest for an uploaded document, by reference.
   *
   * Declared after `follow` and `refreshList` on purpose: it uses both, and
   * depending on declarations that appear later would make the dependency list a
   * lie told to silence a linter.
   */
  const ingestDocument = useCallback(
    async (id: string, options: { compile?: boolean } = {}) => {
      if (!stackId) return;
      setPollNotice(null);
      try {
        const accepted = await client.startIngestForDocument(id, { ...options, stackId });
        follow(accepted.jobId);
      } catch (error) {
        setPollNotice(noticeFor(error));
        return;
      }
      void refreshList();
    },
    [client, follow, refreshList, stackId],
  );

  const start = useCallback(
    async (source: string, options: { compile?: boolean } = {}) => {
      if (!stackId) return;
      const trimmed = source.trim();
      if (!trimmed || starting) return;
      setStarting(true);
      setPollNotice(null);
      try {
        const accepted = await client.startIngest(trimmed, { ...options, stackId });
        // Both dimensions arrive with the 202, so the view has something true to
        // render before the first poll returns.
        setActiveJob({
          id: accepted.jobId,
          source: trimmed,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ingest: accepted.ingest,
          compile: accepted.compile,
        });
        follow(accepted.jobId);
      } catch (error) {
        // A rejected StackId lands here as the server's answer, shown once. There is
        // no retry loop: the tenant is a fact of the link, not a transient failure.
        setPollNotice(noticeFor(error));
      } finally {
        setStarting(false);
        void refreshList();
      }
    },
    [client, follow, refreshList, stackId, starting],
  );

  return {
    stackId,
    blockedProblem: blocked ? MISSING_STACK_ID_PROBLEM : null,
    documents,
    uploading,
    listDocuments,
    upload,
    removeDocument,
    ingestDocument,
    documentsNotice,
    jobs,
    activeJob,
    activeId,
    loadingList,
    listNotice,
    pollNotice,
    starting,
    following,
    start,
    follow,
    stopFollowing,
    refreshList,
    clearPollNotice: () => setPollNotice(null),
  };
}

/** Map a stop reason to what the user can act on. */
export function noticeForOutcome(outcome: PollOutcome): IngestNotice {
  const reason: PollStopReason = outcome.reason;
  if (reason === "settled" || reason === "aborted") return null;
  if (reason === "unavailable") {
    return {
      kind: "unavailable",
      message:
        outcome.message ??
        "This host does not track ingest jobs. The job may still be running; it just cannot be read.",
    };
  }
  if (reason === "unknown") {
    return {
      kind: "unknown",
      message: outcome.message ?? "This job is no longer known to the host.",
    };
  }
  if (reason === "stalled") {
    // Not `unknown`: the job IS known, and its last state is still on screen. What
    // stopped is progress, and the fix is a new ingest, not a reload.
    return {
      kind: "stalled",
      message:
        outcome.message ??
        "This job stopped advancing. Its last state is shown; it will not finish.",
    };
  }
  return { kind: "error", message: outcome.message ?? "The job status could not be read." };
}

/**
 * Map an HTTP failure to a notice.
 *
 * The one distinction that matters: 503 means "not configured / not tracked",
 * which is a deployment fact the user cannot fix, while 404 means "this id is
 * gone", which is a job fact with retention behind it.
 */
export function noticeFor(error: unknown): IngestNotice {
  if (error instanceof ApiError) {
    if (error.status === 503) {
      return {
        kind: "unavailable",
        message:
          error.code === "ingest_not_configured"
            ? "This deployment has no ingest service configured, so job status cannot be read."
            : "The ingest service does not track jobs.",
      };
    }
    if (error.status === 404) {
      return { kind: "unknown", message: "This job is no longer known to the host." };
    }
    if (error.status === 409) {
      return {
        kind: "error",
        message: "Another ingest is running. That is a retry signal, not a failure.",
      };
    }
    return { kind: "error", message: error.message };
  }
  if (error instanceof Error) return { kind: "error", message: error.message };
  return { kind: "error", message: String(error) };
}
