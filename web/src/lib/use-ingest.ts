import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClient, ApiError, type ListedDocument, type UploadedDocument } from "./api.ts";
import {
  compileBlockedByIngestFailure,
  isJobSettled,
  type IngestJob,
  type PollOutcome,
  type PollStopReason,
  type PollTransientFailure,
} from "./ingest.ts";

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
   *
   * `reconnecting` is a fifth and deliberately not a failure: the last read did not
   * answer, the follow is STILL RUNNING, and the last snapshot is still on screen. It is
   * reported by the loop itself, through `onTransient`, so it states what happened rather
   * than guessing from a timer that nothing has arrived.
   */
  kind: "unavailable" | "unknown" | "error" | "not_configured" | "stalled" | "reconnecting";
  message: string;
} | null;

/**
 * How often the Recent list is re-read while the panel is open.
 *
 * Five seconds, for a reason rather than a taste: the job on screen already polls at 250 ms
 * → 2 s, so this interval is only about the ROWS nobody is following — a job someone else
 * started, or one that finished a moment ago. Fast enough that the list is not visibly
 * stale when the panel opens, slow enough that a background tab does not read the list
 * every couple of seconds, and longer than the poll's own ceiling so the two never land in
 * lockstep.
 */
export const LIST_REFRESH_MS = 5_000;

/**
 * What the ingest surface says when the link names no Stack.
 *
 * It names the parameter AND the shape of a working link, because the link is the
 * only fix available: there is nothing to type here and no default to fall back on.
 */
export const MISSING_STACK_ID_PROBLEM =
  "This page needs a stackId in the link. Ingest reads and writes belong to one " +
  "Stack, so without it there is nothing safe to read. Open the link you were " +
  "given, which ends in ?stackId=<stack-id>.";

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
  documents: ListedDocument[];
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
  /**
   * Tell the hook the jobs panel is on screen, and that it is gone again.
   *
   * The interval refresh is scoped to the panel being OPEN, and this hook is created above
   * the view switch — deliberately, so a follow survives a trip to the chat — so the panel
   * is the only thing that knows. `true` while mounted, `false` on the way out.
   */
  setListLive(live: boolean): void;
  /** Start an ingest from a source. A chosen `stackId` wins over the link's Stack. */
  start(source: string, options?: IngestWriteOptions): Promise<void>;
  /**
   * Watch a job. `stackId` is the Stack THAT job belongs to; without it the link's
   * Stack is used, so a row picked from the link's list is read in the link's tenant.
   */
  follow(id: string, options?: { stackId?: string | undefined }): void;
  stopFollowing(): void;
  refreshList(): Promise<void>;
  /**
   * Delete one job. A chosen `stackId` wins over the link's, like every other write.
   *
   * The service's refusal is the answer: a working job is not interrupted, it is
   * refused with `409 job_still_working`, and that is what the user reads. Nothing
   * repeats a rejected request.
   */
  deleteJob(id: string, options?: { stackId?: string | undefined }): Promise<void>;
  /**
   * Ask the service to ingest the same source again, as a NEW job, and follow it.
   *
   * Refusals travel the same way a delete's do; a retry that is refused leaves the
   * job on screen exactly as it was.
   */
  retryJob(id: string, options?: { stackId?: string | undefined }): Promise<void>;
  /** Ids with a DELETE in flight, so a row disables its own button and nothing else. */
  deletingIds: ReadonlySet<string>;
  /** Ids with a retry POST in flight, kept apart from `deletingIds` for the same reason. */
  retryingIds: ReadonlySet<string>;
  clearPollNotice(): void;
}

export function useIngest({
  client,
  stackId,
  listRefreshMs = LIST_REFRESH_MS,
}: {
  client: ApiClient;
  /** The tenant, already resolved from the link. `null` blocks the whole surface. */
  stackId: string | null;
  /** Injection seam for tests: how often the list is re-read while it is live. */
  listRefreshMs?: number;
}): UseIngestResult {
  // Read once and never mutated: the link is the only source, so there is no
  // selection to track and nothing a later render could contradict.
  const blocked = stackId === null;

  const [documents, setDocuments] = useState<ListedDocument[]>([]);
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
  // Whether the jobs panel is on screen. The interval refresh is scoped to this and not to
  // the hook's lifetime, because the hook outlives the view on purpose.
  const [listLive, setListLive] = useState(false);
  // The user's explicit choice on this surface. `null` until they pick: the link's value
  // is applied as the fallback by `resolvedStackId` rather than copied into state, so a
  // link that changes still decides until someone chooses otherwise.
  const [chosenStackId, setChosenStackId] = useState<string | null>(null);
  // What the host says exists. Empty is a real answer — "no choices to offer" — and it
  // does not erase the link's Stack, which `mergeStackIds` keeps.
  const [knownStackIds, setKnownStackIds] = useState<string[]>([]);
  // Per-id, per-control in-flight markers. Two sets rather than one boolean: the panel
  // disables and labels the button that is actually out, and a retry on one job must
  // not look like a delete on another.
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(new Set());
  const [retryingIds, setRetryingIds] = useState<ReadonlySet<string>>(new Set());
  /**
   * The same ids, as a guard rather than as a render input.
   *
   * A second click on a button whose state has not re-rendered yet must not become a
   * second request, and reading the state for that would make every callback depend on
   * it. One key per control, so a delete and a retry of the same job stay independent.
   */
  const inFlight = useRef<Set<string>>(new Set());

  const abortRef = useRef<AbortController | null>(null);

  /**
   * Whether a list read is outstanding.
   *
   * Read by the interval tick and by nothing else: an explicit refresh (mount, and after
   * every action) keeps its old behaviour of simply asking, because dropping it would make
   * the list the user just changed wait for a tick. A timer, on the other hand, must not
   * stack a second read on a host that has not answered the first.
   */
  const listInFlight = useRef(false);

  /**
   * Whether the list has answered at least once on this visit.
   *
   * The re-attach decision below waits for a real answer rather than for a mount: an empty
   * list is a fact, a list that has not arrived is not, and a failed first read must not
   * spend the visit's one chance to adopt a job.
   */
  const listReadOnce = useRef(false);

  /**
   * Whether the re-attach automation has had its chance on this visit.
   *
   * One chance, taken once: the automation adopts a job, or decides there is none to adopt,
   * and then it is over — for the user's explicit choices (a follow of another job, a
   * `stopFollowing`) and for the job it adopted ending, this visit is the user's.
   */
  const autoResumeDone = useRef(false);

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
    listInFlight.current = true;
    try {
      const list = await client.listIngestJobs(stackId);
      setJobs(list);
      listReadOnce.current = true;
      setListNotice(null);
    } catch (error) {
      setListNotice(noticeFor(error));
    } finally {
      listInFlight.current = false;
      setLoadingList(false);
    }
  }, [client, stackId]);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  /**
   * Re-read the list on an interval, while the panel says it is open.
   *
   * A tick that lands on an outstanding read is DROPPED rather than queued, which is what
   * keeps a slow host from being asked again before it has answered. With no Stack the
   * timer is not even created: there is nothing safe to read, and `refreshList` refuses
   * anyway.
   */
  useEffect(() => {
    if (!listLive || !stackId) return;
    const timer = setInterval(() => {
      if (listInFlight.current) return;
      void refreshList();
    }, listRefreshMs);
    return () => clearInterval(timer);
  }, [listLive, listRefreshMs, refreshList, stackId]);

  // A poll loop outliving the view would keep calling a component that no longer
  // exists; the abort is what actually ends it.
  useEffect(() => () => abortRef.current?.abort(), []);

  const stopFollowing = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setFollowing(false);
    // Stopping IS an instruction: the automation must not start another follow behind it.
    autoResumeDone.current = true;
  }, []);

  const follow = useCallback(
    (id: string, options: { stackId?: string | undefined } = {}) => {
      // Asking to watch something specific is the user taking the screen: whatever the
      // automation might have adopted on this visit, it does not get to do it now.
      autoResumeDone.current = true;
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
          onUpdate: (job) => {
            setActiveJob(job);
            // A read that succeeded ends the reconnect: the notice a blip put on screen is
            // cleared by the recovery itself, not by the user clicking Dismiss.
            setPollNotice((current) => (current?.kind === "reconnecting" ? null : current));
          },
          onTransient: (failure) => setPollNotice(reconnectingNotice(failure)),
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
   * The re-attach: on the first list read of a visit, adopt the job that is still working.
   *
   * This is the fix for "I have to press F5 to see the job again". It is AUTOMATIC and has
   * no link parameter (Option A of `odd/tasks/ingest-follow-resilience.md` L3): the whole
   * point is that a plain reload of the same link gets the state back, so making the
   * recovery depend on the user editing the URL would reintroduce the action being removed.
   *
   * It runs at most once per visit, and it yields to the user in every direction: a job
   * already being followed, an explicit `follow` of another job, a `stopFollowing`, and the
   * adopted job ending all end it, because a screen that keeps re-adopting jobs is a screen
   * the user cannot steer.
   */
  useEffect(() => {
    if (autoResumeDone.current || !listReadOnce.current) return;
    // One chance, whatever the answer: adopting nothing is also a decision.
    autoResumeDone.current = true;
    // Something is already on screen (a job started from the form before the list
    // answered, say). Never replace it.
    if (activeId !== null) return;
    const candidate = mostRecentlyUpdatedRunning(jobs);
    if (candidate) follow(candidate.id);
  }, [activeId, follow, jobs]);

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

  /**
   * Delete one job.
   *
   * ## What the hook does NOT decide
   *
   * Whether a job is deletable. The service owns that: a working job is refused with
   * `409 job_still_working`, and that refusal is the answer to show. Guessing from a
   * status snapshot would refuse jobs the host would accept and accept jobs it will not.
   *
   * ## One click, one request
   *
   * A second click while the first request is out is dropped here rather than sent
   * twice, and a rejection is never repeated. Only a successful delete stops the poll
   * and clears the detail — doing it any earlier would close the view of a job that the
   * host just told us still exists.
   */
  const deleteJob = useCallback(
    async (id: string, options: { stackId?: string | undefined } = {}) => {
      const targetStackId = effectiveStackId(options.stackId, resolvedStackId);
      if (!targetStackId) {
        setPollNotice(unresolvedStackIdNotice());
        return;
      }
      const key = `delete:${id}`;
      if (inFlight.current.has(key)) return;
      inFlight.current.add(key);
      setDeletingIds((current) => withId(current, id));
      setPollNotice(null);
      try {
        await client.deleteIngestJob(id, targetStackId);
      } catch (error) {
        setPollNotice(noticeFor(error));
        return;
      } finally {
        inFlight.current.delete(key);
        setDeletingIds((current) => withoutId(current, id));
      }
      // The job is gone, so watching it is watching nothing: the poll ends and the
      // detail pane is cleared when this was the job on screen. A different job being
      // watched is left exactly as it was.
      if (activeId === id) {
        stopFollowing();
        setActiveJob(null);
        setActiveId(null);
      }
      void refreshList();
    },
    [activeId, client, refreshList, resolvedStackId, stopFollowing],
  );

  /**
   * Retry one job: the service creates a NEW job from the same source.
   *
   * The follow moves to the id the answer carries (`jobId`, else `id`), because that is
   * the job that will make progress — reading the old one would show a job the retry did
   * not restart. No id in the answer means no new job to watch, and the refreshed list is
   * then what the user has.
   */
  const retryJob = useCallback(
    async (id: string, options: { stackId?: string | undefined } = {}) => {
      const targetStackId = effectiveStackId(options.stackId, resolvedStackId);
      if (!targetStackId) {
        setPollNotice(unresolvedStackIdNotice());
        return;
      }
      const key = `retry:${id}`;
      if (inFlight.current.has(key)) return;
      inFlight.current.add(key);
      setRetryingIds((current) => withId(current, id));
      setPollNotice(null);
      try {
        const newJobId = await client.retryIngestJob(id, targetStackId);
        if (newJobId) follow(newJobId, { stackId: targetStackId });
      } catch (error) {
        setPollNotice(noticeFor(error));
        return;
      } finally {
        inFlight.current.delete(key);
        setRetryingIds((current) => withoutId(current, id));
      }
      void refreshList();
    },
    [client, follow, refreshList, resolvedStackId],
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
    setListLive,
    start,
    follow,
    stopFollowing,
    refreshList,
    deleteJob,
    retryJob,
    deletingIds,
    retryingIds,
    clearPollNotice: () => setPollNotice(null),
  };
}

/**
 * The job the re-attach should adopt: the most recently updated one that still has work
 * ahead of it.
 *
 * "Still running" is NOT `!isJobSettled`. A job whose ingest failed while its compile reads
 * `queued` is not settled by the pair, but nothing will ever start that compile
 * (`compileBlockedByIngestFailure`), so adopting it would open the panel on a corpse and
 * then report it stalled. The candidate set is therefore "not settled AND not blocked", and
 * `updatedAt` — which the producer writes on every transition — picks the freshest.
 *
 * A tie keeps the earlier job in the list's order, and an unparsable timestamp cannot win
 * over a real one: neither is worth a second rule.
 */
function mostRecentlyUpdatedRunning(jobs: IngestJob[]): IngestJob | undefined {
  const updatedAtMs = (job: IngestJob): number => {
    const at = Date.parse(job.updatedAt);
    return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
  };
  return jobs
    .filter((job) => !isJobSettled(job) && !compileBlockedByIngestFailure(job))
    .reduce<IngestJob | undefined>(
      (best, job) => (best === undefined || updatedAtMs(job) > updatedAtMs(best) ? job : best),
      undefined,
    );
}

/** The same set with `id` added, as a new value so React sees the change. */
function withId(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(ids);
  next.add(id);
  return next;
}

/** The same set with `id` removed, as a new value. */
function withoutId(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(ids);
  next.delete(id);
  return next;
}

/**
 * A refusal, in the words the service used.
 *
 * The code is prepended when the message does not already carry it, because
 * `job_still_working` and `job_changed` are the two facts an operator distinguishes and
 * the sentence alone may not name either. A body that said nothing at all is stated as
 * the refusal it is, rather than as `request failed with 409` — that reads like a
 * temporary network fault, and invites exactly the retry loop this surface refuses.
 */
function refusalMessage(error: ApiError): string {
  const said = error.message.trim();
  const heardNothing = said === "" || said === `request failed with ${error.status}`;
  if (heardNothing) {
    return error.code
      ? `The host refused this request: ${error.code}.`
      : `The ingest service refused this request (${error.status}).`;
  }
  return error.code && !said.includes(error.code) ? `${error.code}: ${said}` : said;
}

/**
 * A document refusal, in the service's own words.
 *
 * The sentence is the answer here: it names the retraction endpoint that would allow the
 * delete. So it is NOT prefixed with the code (unlike {@link refusalMessage}, where the
 * code is the fact) and it is not rewritten — a paraphrase could drop the endpoint. Only
 * a body that said nothing at all falls back to a sentence of our own, which still says
 * what to do rather than looking like a transient fault.
 */
function documentRefusalMessage(error: ApiError): string {
  const said = error.message.trim();
  const heardNothing = said === "" || said === `request failed with ${error.status}`;
  return heardNothing
    ? "This document is ingested; retract it before it can be deleted."
    : said;
}

/**
 * The notice for a read that failed while the follow keeps going.
 *
 * Two sentences, and both halves are load-bearing: what the read said, and that the job is
 * still being followed. Without the second the message reads like the failure the loop
 * used to end on — which is the bug this replaces.
 */
export function reconnectingNotice(failure: PollTransientFailure): IngestNotice {
  const said = failure.message.trim();
  return {
    kind: "reconnecting",
    message:
      `The job status could not be read just now: ${said === "" ? "no answer." : said} ` +
      "Still trying, and the last state stays on screen.",
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
 * The upstream job-control refusals: the two codes a delete or a retry can carry.
 *
 * These are an ALLOW-LIST on purpose. A `409` reaching this surface is one of two
 * unrelated facts, and the only thing that separates them is the code the response
 * carries — so the branch below has to name the codes that mean "the host answered
 * about this job" rather than assume any code at all does. The concurrency lock that
 * `start` hits also arrives with a code of its own (`busy`), and that one is not a
 * job-control answer.
 */
const JOB_CONTROL_REFUSAL_CODES: ReadonlySet<string> = new Set(["job_still_working", "job_changed"]);

/**
 * The document refusal: the delete guard's answer, on the same status code.
 *
 * `DELETE /documents/:id` answers `409 document_ingested` while the wiki still compiles
 * these bytes, and its message names the retraction that would unblock it. It belongs to
 * a THIRD fact — neither a job that is working nor a lock — so it is classified by name
 * here rather than by status below. One code, one constant: the next document refusal
 * (S5's `document_not_ingested`) is added in this list, not in a second branch.
 */
const DOCUMENT_REFUSAL_CODES: ReadonlySet<string> = new Set(["document_ingested"]);

/**
 * What a `409` with no job-control code means: one ingest at a time, try again later.
 *
 * The exact sentence this surface has shown for the concurrency lock since before the
 * operator controls existed. It is kept byte for byte: the host's own body for that lock
 * says less than this, and the operator has to read "retry", not "failed".
 */
const INGEST_ALREADY_RUNNING_NOTICE =
  "Another ingest is running. That is a retry signal, not a failure.";

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
      // One status, THREE unrelated facts — and the response is the only thing that tells
      // them apart, so nothing here is branched on that the caller cannot see.
      //
      // A document refusal (`document_ingested`) is the delete guard answering: these
      // bytes are still compiled by the wiki. Its message is passed through VERBATIM,
      // because it is the only part of the answer that names what would work
      // (`POST /documents/<id>/retract`), and paraphrasing it into the concurrency
      // sentence would be a false statement *and* would hide the fix.
      //
      // A job-control refusal (`job_still_working`, `job_changed`) is the host's ANSWER
      // about one job: a working job is refused rather than interrupted, and a job that
      // moved under us is refused too. One friendly sentence for both would erase the
      // difference the user has to act on and would hide the code the service chose, so
      // its own words reach the screen, once.
      //
      // Any other 409 on these routes is the concurrency lock — `start` hitting an ingest
      // that is already running — and that is a retry signal, not a failure. It keeps the
      // sentence this surface has always shown for it, unchanged.
      if (error.code && DOCUMENT_REFUSAL_CODES.has(error.code)) {
        return { kind: "error", message: documentRefusalMessage(error) };
      }
      if (error.code && JOB_CONTROL_REFUSAL_CODES.has(error.code)) {
        return { kind: "error", message: refusalMessage(error) };
      }
      return { kind: "error", message: INGEST_ALREADY_RUNNING_NOTICE };
    }
    return { kind: "error", message: error.message };
  }
  if (error instanceof Error) return { kind: "error", message: error.message };
  return { kind: "error", message: String(error) };
}
