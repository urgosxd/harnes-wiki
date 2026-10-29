import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClient, ApiError, type UploadedDocument } from "./api.ts";
import {
  checkCreateTarget,
  defaultStackId,
  parseStacksPayload,
  type CreateTargetCheck,
  type StackOption,
} from "./stacks.ts";
import { pollJob, type IngestJob, type PollOutcome, type PollStopReason } from "./ingest.ts";

/**
 * Owns the ingest-jobs view: the list, the polled job, and the stop notice.
 *
 * Three things this hook deliberately does NOT do:
 *
 *  - It does not merge the two dimensions into one state. The job object is
 *    passed through exactly as the server returned it.
 *  - It does not invent progress. `progress` reaches the component untouched,
 *    `null` included.
 *  - It does not retry a 404 or a 503. Both are stated outcomes the user must
 *    see; a silent retry would turn "this job expired" into an endless spinner.
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

export interface UseIngestResult {
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

  /**
   * Stacks offered by the picker.
   *
   * Populated from the AGENT's `list_stacks` result, not from a direct call: this
   * server holds no registry of them, and a stack offered here but unknown to the
   * agent would produce calls the service rejects.
   */
  stacks: StackOption[];
  /** Set when the stack list could not be read — never merely because it was empty. */
  stacksProblem: string | null;
  /** The stack selected in the picker, or null when none was chosen. */
  selectedStackId: string | null;
  selectStack(id: string | null): void;
  /**
   * Whether a job started now would land in the Stack the picker shows.
   *
   * Exposed rather than enforced internally, so the panel can disable its controls
   * AND say why. Silently refusing, or silently creating elsewhere, are the two ways
   * this went wrong before.
   */
  createTarget: CreateTargetCheck;
  /** Feed a `list_stacks` payload from the agent's turn. */
  observeStacks(text: string, isError: boolean): void;

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

export function useIngest({ client }: { client: ApiClient }): UseIngestResult {
  const [stacks, setStacks] = useState<StackOption[]>([]);
  const [stacksProblem, setStacksProblem] = useState<string | null>(null);
  const [selectedStackId, setSelectedStackId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<UploadedDocument[]>([]);
  const [uploading, setUploading] = useState(false);
  const [documentsNotice, setDocumentsNotice] = useState<IngestNotice>(null);
  const [jobs, setJobs] = useState<IngestJob[]>([]);
  const [activeJob, setActiveJob] = useState<IngestJob | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [listNotice, setListNotice] = useState<IngestNotice>(null);
  const [pollNotice, setPollNotice] = useState<IngestNotice>(null);
  const [starting, setStarting] = useState(false);
  const [following, setFollowing] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  const listDocuments = useCallback(async () => {
    try {
      setDocuments(await client.listDocuments());
      setDocumentsNotice(null);
    } catch (error) {
      setDocumentsNotice(noticeFor(error));
    }
  }, [client]);

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
    [client, listDocuments],
  );

  const removeDocument = useCallback(
    async (id: string) => {
      try {
        await client.deleteDocument(id);
        await listDocuments();
      } catch (error) {
        setDocumentsNotice(noticeFor(error));
      }
    },
    [client, listDocuments],
  );

  // Read through a ref so a refresh always sees the LATEST selection without the
  // callback being rebuilt on every keystroke of a picker.
  const selectedStackRef = useRef<string | null>(null);
  selectedStackRef.current = selectedStackId;

  const refreshList = useCallback(async () => {
    try {
      const list = await client.listIngestJobs(selectedStackRef.current ?? undefined);
      setJobs(list);
      setListNotice(null);
    } catch (error) {
      setListNotice(noticeFor(error));
    } finally {
      setLoadingList(false);
    }
  }, [client]);

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
      stopFollowing();
      const controller = new AbortController();
      abortRef.current = controller;
      setActiveId(id);
      setFollowing(true);
      setPollNotice(null);

      void client
        .pollIngestJob(id, {
          signal: controller.signal,
          ...(selectedStackRef.current ? { stackId: selectedStackRef.current } : {}),
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
    [client, refreshList, stopFollowing],
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
      setPollNotice(null);
      try {
        const accepted = await client.startIngestForDocument(id, {
          ...options,
          ...(selectedStackRef.current ? { stackId: selectedStackRef.current } : {}),
        });
        follow(accepted.jobId);
      } catch (error) {
        setPollNotice(noticeFor(error));
        return;
      }
      void refreshList();
    },
    [client, follow, refreshList],
  );

  const start = useCallback(
    async (source: string, options: { compile?: boolean } = {}) => {
      const trimmed = source.trim();
      if (!trimmed || starting) return;
      setStarting(true);
      setPollNotice(null);
      try {
        const accepted = await client.startIngest(trimmed, {
          ...options,
          ...(selectedStackRef.current ? { stackId: selectedStackRef.current } : {}),
        });
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
        setPollNotice(noticeFor(error));
      } finally {
        setStarting(false);
        void refreshList();
      }
    },
    [client, follow, refreshList, starting],
  );

  /**
   * Read a `list_stacks` payload the agent produced.
   *
   * The service answers `isError` for an id that does not exist so that "no such
   * stack" and "no stacks" cannot be confused; the same distinction is kept here,
   * because a picker that showed emptiness for a failure would invite the user to
   * pick from nothing.
   */
  const observeStacks = useCallback((text: string, isError: boolean) => {
    if (isError) {
      setStacksProblem(text.trim() || "The stack list could not be read.");
      return;
    }
    const parsed = parseStacksPayload(text);
    setStacks(parsed.stacks);
    setStacksProblem(parsed.problem);
    // Selecting the bound stack on first sight is convenience, not a decision the
    // user made; an explicit choice is never overwritten by a later refresh.
    setSelectedStackId((current) => current ?? defaultStackId(parsed.stacks));
  }, []);

  return {
    stacks,
    stacksProblem,
    selectedStackId,
    createTarget: checkCreateTarget(stacks, selectedStackId),
    selectStack: setSelectedStackId,
    observeStacks,
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
