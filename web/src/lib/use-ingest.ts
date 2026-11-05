import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClient, ApiError, type UploadedDocument } from "./api.ts";
import { type IngestJob, type PollOutcome, type PollStopReason } from "./ingest.ts";

/**
 * Owns the ingest-jobs view: the list, the polled job, and the stop notice.
 *
 * ## Reads take the link's tenant; writes take the caller's choice, then the link's
 *
 * `stackId` arrives already resolved from the link (see `tenant.ts`). Every READ — the
 * list, the poll — and the document resources carry it verbatim, because the service
 * scopes reads by Stack.
 *
 * A write (`start`, `ingestDocument`) resolves its Stack in one place, `effectiveStackId`:
 * the Stack chosen for that call wins, and the link's value is the fallback. Before that
 * helper existed the link's value was spread AFTER the caller's options, so a chosen
 * Stack was discarded with no error and the job went to the other tenant.
 *
 * When NEITHER source names a Stack, this hook is BLOCKED: it performs no request at all,
 * not a listing, not a poll, not a create. The honest reason is not performance —
 * a list read with no Stack is not an empty list, it is a read of whatever tenant the
 * endpoint happens to be bound to, which is exactly the coupling this product is
 * removing. `blockedProblem` is what the panel shows instead, and an ingest attempt in
 * that state reports `UNRESOLVED_STACK_ID_NOTICE` rather than returning silently.
 *
 * ## The panel's choice is a source of its own, and it stops at the job it started
 *
 * `chooseStackId` records the Stack the user picked on this surface, and
 * `resolvedStackId` is that choice with the link as its fallback, so the panel never
 * derives the order itself. The choice scopes the WRITES it starts plus the poll for
 * the job they created — a job in Stack C has to be watched in Stack C, or the panel
 * shows nothing for it — and it deliberately does NOT scope the list, document or
 * upload reads, which stay the link's tenant. A choice that leaked into those would
 * relabel one Stack's jobs as another's.
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

/**
 * What an ingest attempt says when neither source names a Stack.
 *
 * `MISSING_STACK_ID_PROBLEM` is the copy for a blocked READ, where the link is the only
 * fix. A write has two sources now, so its copy has to name both of them — a caller that
 * could have passed a Stack must not be told the link was its only option — and then say
 * the two things that actually work.
 */
export const UNRESOLVED_STACK_ID_NOTICE =
  "This ingest names no Stack: no Stack was chosen for it and the link names none. " +
  "Choose a Stack, or open a link that ends in ?stackId=<stack-id>.";

/**
 * Per-call options for the two ingest paths that write into a Stack.
 *
 * `stackId` is the caller's choice for this one call; the hook's link-derived Stack
 * remains the fallback, so a caller that passes nothing keeps exactly the old behavior.
 */
export interface IngestWriteOptions {
  compile?: boolean;
  /** The Stack this call belongs to. Wins over the link's. Blank means "not chosen". */
  stackId?: string | undefined;
}

/**
 * Which Stack a write belongs to.
 *
 * ONE implementation on purpose. Two call sites each deciding their own argument order
 * is exactly how the bug this replaces survived: the link's value was spread last and
 * silently overwrote the choice. The order is the product rule — the Stack chosen for
 * this call wins, the link is the fallback — and `null` means neither answered.
 *
 * Blank counts as "not chosen" on both levels: an empty string would name a Stack
 * called "", and a request into a tenant nobody named is worse than no request.
 */
function effectiveStackId(chosen: string | undefined, fromLink: string | null): string | null {
  const chosenTrimmed = chosen?.trim();
  if (chosenTrimmed) return chosenTrimmed;
  const linkTrimmed = fromLink?.trim();
  return linkTrimmed ? linkTrimmed : null;
}

/** The single notice for "neither source named a Stack", on the channel 202s and rejections already use. */
function unresolvedStackIdNotice(): IngestNotice {
  return { kind: "error", message: UNRESOLVED_STACK_ID_NOTICE };
}

/**
 * The options the Stack control offers.
 *
 * The host's list is the source of truth for what EXISTS, but not for what this page may
 * name: the link already named a Stack, and a list read that omits it — a stale cache, a
 * host that does not list every Stack — must not turn the current tenant into an
 * unselected blank. So the resolved id joins the front of the list and nothing a person
 * is working in gets dropped.
 */
function mergeStackIds(known: string[], resolved: string | null): string[] {
  const ids = known.map((id) => id.trim()).filter((id) => id !== "");
  if (resolved && !ids.includes(resolved)) ids.unshift(resolved);
  return ids;
}

export interface UseIngestResult {
  /**
   * The tenant Stack, read once from the link and never defaulted or remembered.
   *
   * `null` means the link named none, which blocks every read and write below.
   */
  stackId: string | null;
  /**
   * The Stack this surface's writes belong to: the one chosen here, else the link's.
   *
   * `null` means neither answered, which is the S4 case. The panel says so and offers
   * no way to send a request into a tenant nobody named.
   */
  resolvedStackId: string | null;
  /**
   * The Stack ids the host offered, with the resolved id added when the host did not
   * list it. Never empty while a Stack is resolved, so the link's own value stays
   * selectable offline.
   */
  stackIds: string[];
  /** Choose the Stack for this surface's writes. `null` clears back to the link's. */
  chooseStackId(id: string | null): void;
  /** Why the surface is blocked, or `null` once the link named a Stack. */
  blockedProblem: string | null;

  /** Files this user has uploaded, newest first. Each is a resource, not a job. */
  documents: UploadedDocument[];
  uploading: boolean;
  listDocuments(): Promise<void>;
  upload(file: File): Promise<UploadedDocument | null>;
  removeDocument(id: string): Promise<void>;
  /** Start an ingest for an uploaded document, by reference. */
  ingestDocument(id: string, options?: IngestWriteOptions): Promise<void>;
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
  /** Start an ingest from a source. A chosen `stackId` wins over the link's Stack. */
  start(source: string, options?: IngestWriteOptions): Promise<void>;
  /**
   * Watch a job. `stackId` is the Stack THAT job belongs to; without it the link's
   * Stack is used, so a row picked from the link's list is read in the link's tenant.
   */
  follow(id: string, options?: { stackId?: string | undefined }): void;
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
  // The user's explicit choice on this surface. `null` until they pick: the link's value
  // is applied as the fallback by `resolvedStackId` rather than copied into state, so a
  // link that changes still decides until someone chooses otherwise.
  const [chosenStackId, setChosenStackId] = useState<string | null>(null);
  // What the host says exists. Empty is a real answer — "no choices to offer" — and it
  // does not erase the link's Stack, which `mergeStackIds` keeps.
  const [knownStackIds, setKnownStackIds] = useState<string[]>([]);

  const abortRef = useRef<AbortController | null>(null);

  /**
   * The choices the control offers.
   *
   * A failed read is NOT a failed surface: a host that cannot list its Stacks still
   * accepts writes into the one the link names, so this degrades to "no choices beyond
   * the link's" instead of blocking anything. Decided here, once, so no caller has to
   * invent a fallback list of its own.
   */
  const loadStackIds = useCallback(async () => {
    try {
      setKnownStackIds(await client.listStackIds());
    } catch {
      setKnownStackIds([]);
    }
  }, [client]);

  useEffect(() => {
    void loadStackIds();
  }, [loadStackIds]);

  // The one place the order lives for this surface: the choice, then the link.
  const resolvedStackId = effectiveStackId(chosenStackId ?? undefined, stackId);

  const stackIds = mergeStackIds(knownStackIds, resolvedStackId);

  const chooseStackId = useCallback((id: string | null) => {
    const trimmed = id?.trim();
    setChosenStackId(trimmed ? trimmed : null);
  }, []);

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
    (id: string, options: { stackId?: string | undefined } = {}) => {
      // A job is watched in the Stack it belongs to: the one chosen for its start, else
      // the link's. Nothing to follow without one — the read would answer for whichever
      // Stack the endpoint is bound to. Only an explicit per-job Stack is honored here:
      // the surface's own choice must not leak onto a row picked from the link's list,
      // which is why this does not fall back to `resolvedStackId`.
      const targetStackId = effectiveStackId(options.stackId, stackId);
      if (!targetStackId) return;
      stopFollowing();
      const controller = new AbortController();
      abortRef.current = controller;
      setActiveId(id);
      setFollowing(true);
      setPollNotice(null);

      void client
        .pollIngestJob(id, {
          signal: controller.signal,
          stackId: targetStackId,
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
    async (id: string, options: IngestWriteOptions = {}) => {
      // Same rule and same helper as `start`: choice first, link as fallback, and a
      // notice instead of a silent no-op when neither names a Stack.
      const targetStackId = effectiveStackId(options.stackId, resolvedStackId);
      if (!targetStackId) {
        setPollNotice(unresolvedStackIdNotice());
        return;
      }
      setPollNotice(null);
      try {
        const accepted = await client.startIngestForDocument(id, {
          ...options,
          stackId: targetStackId,
        });
        // The job is watched in the Stack it was created in, not the link's.
        follow(accepted.jobId, { stackId: targetStackId });
      } catch (error) {
        setPollNotice(noticeFor(error));
        return;
      }
      void refreshList();
    },
    [client, follow, refreshList, resolvedStackId],
  );

  const start = useCallback(
    async (source: string, options: IngestWriteOptions = {}) => {
      // The choice wins, the link is the fallback. Neither answering is a fact the user
      // must see: the previous silent `return` made the form look like a dead button.
      const targetStackId = effectiveStackId(options.stackId, resolvedStackId);
      if (!targetStackId) {
        setPollNotice(unresolvedStackIdNotice());
        return;
      }
      const trimmed = source.trim();
      if (!trimmed || starting) return;
      setStarting(true);
      setPollNotice(null);
      try {
        const accepted = await client.startIngest(trimmed, { ...options, stackId: targetStackId });
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
        // This job belongs to `targetStackId`, so it is polled there even when the link
        // named no Stack: the POST alone would leave the panel with nothing to show.
        follow(accepted.jobId, { stackId: targetStackId });
      } catch (error) {
        // A rejected StackId lands here as the server's answer, shown once. There is
        // no retry loop: the tenant is a fact of the link, not a transient failure.
        setPollNotice(noticeFor(error));
      } finally {
        setStarting(false);
        void refreshList();
      }
    },
    [client, follow, refreshList, resolvedStackId, starting],
  );

  return {
    stackId,
    resolvedStackId,
    stackIds,
    chooseStackId,
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
