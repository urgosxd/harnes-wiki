/**
 * @file src/lib/ingest.ts
 * @description The ingest-job contract as the UI sees it, plus the polling loop.
 *
 * ## Two dimensions, never one status
 *
 * `ingest` and `compile` are independent state machines that fail separately. A
 * job whose ingest succeeded and whose compile is `busy` is a normal, common
 * state — the source IS on disk and only the compile needs a retry. Collapsing
 * that into one "failed" would send a user to re-upload a file that already
 * landed, so nothing in this module produces a single status.
 *
 * `ingest.unchanged` is likewise NOT `succeeded`: identical content was re-sent,
 * nothing was written and nothing was journalled. Both are terminal, but they
 * answer different questions, so both are kept.
 *
 * ## Progress is never invented
 *
 * There is no percentage anywhere in this file's inputs, and none is computed on
 * the way out. `progress` is either `null` — the pipeline does not know its
 * denominator, so the UI shows an indeterminate indicator and the stage name — or
 * an exact `{completed, total}` pair. Only `page_generation` and `finalize` carry
 * a real total today.
 *
 * ## No stream exists, so this polls
 *
 * There is no SSE and no WebSocket. Polling starts at 250 ms and backs off to at
 * most 2 s, and it stops only when BOTH dimensions are terminal-or-absent.
 *
 * ## The payload's `dimensions` array is a report, not a lifecycle
 *
 * The producer also publishes per-dimension results (`wiki`, `kg`, …). Those are RENDERED
 * — `dimensionRows` narrows them to rows the panel can show — and they deliberately do not
 * feed `isJobSettled`, which keeps reading the `ingest`/`compile` pair.
 */

/** Terminal `ingest.status` values: nothing will change these again. */
const SETTLED_INGEST = new Set(["succeeded", "unchanged", "failed"]);

/** Terminal `compile.status` values. `busy` is terminal: the source is on disk. */
const SETTLED_COMPILE = new Set(["succeeded", "busy", "failed", "skipped"]);

/** Stages an ingest passes through, in execution order. */
export const INGEST_STAGES = [
  "detecting",
  "fetching",
  "extracting",
  "preparing",
  "committing",
  "projecting",
  "journaling",
] as const;

/** Stages a compile passes through, in the pipeline's own measured order. */
export const COMPILE_STAGES = [
  "detect_changes",
  "extraction",
  "page_generation",
  "finalize",
  "embeddings",
] as const;

export type IngestStatus = "queued" | "running" | "succeeded" | "unchanged" | "failed";
export type IngestStage = (typeof INGEST_STAGES)[number];
export type CompileStatus = "skipped" | "busy" | "queued" | "running" | "succeeded" | "failed";
export type CompileStage = (typeof COMPILE_STAGES)[number];

/**
 * One attempt at the transaction.
 *
 * No `endedAt` means the attempt is in flight. An `error` means that attempt
 * rolled back — the pipeline's existing retry loop made visible, not a new
 * retry policy.
 */
export interface IngestAttempt {
  attempt: number;
  startedAt: string;
  endedAt?: string;
  error?: string;
}

export interface IngestDimension {
  status: IngestStatus;
  stage?: IngestStage;
  startedAt?: string;
  endedAt?: string;
  attempts: IngestAttempt[];
  message?: string;
  error?: string;
}

/** A real `completed` of `total` pair, or `null` when the denominator is unknown. */
export interface JobProgress {
  completed: number;
  total: number;
}

export interface CompileDimension {
  status: CompileStatus;
  stage?: CompileStage;
  startedAt?: string;
  endedAt?: string;
  progress: JobProgress | null;
  /**
   * Counts that do NOT fit in `progress`, when the producer publishes them.
   *
   * The embeddings stage embeds PAGES and, separately, CHUNKS of those pages - one
   * page yields several chunks, so 93 pages produced 442 chunks. A single
   * `{completed, total}` pair cannot carry both, and merging them into one number
   * would be fabricated progress. So the ratio stays pages and anything else arrives
   * here, where it informs without corrupting what the bar means.
   *
   * Optional because the producer does not emit it yet; absent means simply absent,
   * never zero, so a renderer must not infer "no chunks" from a missing field.
   */
  detail?: { chunks?: number; requests?: number };
  message?: string;
  error?: string;
}

export interface IngestJob {
  id: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  ingest: IngestDimension;
  compile: CompileDimension;
  /**
   * Per-dimension results, as the producer publishes them.
   *
   * `unknown` on purpose, and this is the only field in this module with that type. The
   * producer is an EXTERNAL service: it can add a dimension this build has never heard of,
   * and it can answer a shape nobody promised. A declared `Array<{name: string}>` would be
   * a promise this side cannot keep — it would typecheck while the value was `42`, and the
   * first non-object entry would throw inside render. So the payload stays unknown here and
   * `dimensionRows` below narrows it, entry by entry, to something renderable.
   */
  dimensions?: unknown;
}

/** The `202` answer: the job identity plus both dimensions as they started. */
export interface IngestJobAccepted {
  jobId: string;
  status: IngestStatus;
  stage: IngestStage | "queued";
  ingest: IngestDimension;
  compile: CompileDimension;
}

/** True when this dimension will not change again. */
export function isIngestSettled(ingest: IngestDimension): boolean {
  return SETTLED_INGEST.has(ingest.status);
}

export function isCompileSettled(compile: CompileDimension): boolean {
  return SETTLED_COMPILE.has(compile.status);
}

/**
 * True when the WHOLE job is done.
 *
 * Both halves must be terminal. `ingest.succeeded` with `compile.running` is
 * still work in progress, and stopping the poller there would freeze the UI on a
 * compile that is about to finish or fail.
 *
 * ## This reads `ingest`/`compile` and NOT `dimensions`, deliberately
 *
 * The payload's `dimensions` array is RENDERED (`dimensionRows`); it does not decide when
 * the loop stops. Whether a dimension can reach a terminal status before the overall job
 * status does is UNVERIFIED — nothing in this repository observes the producer's
 * scheduler — and a settle rule built on that guess fails in both directions: guess "a
 * settled dimension ends the job" wrongly and the screen freezes on work still happening;
 * guess the ordering the other way and a finished job polls forever. So the lifecycle
 * stays the pair the service documents as two state machines, and the array informs the
 * screen without moving the rule.
 */
export function isJobSettled(job: IngestJob): boolean {
  return isIngestSettled(job.ingest) && isCompileSettled(job.compile);
}

/**
 * One dimension row the panel can render: a name, a status, and optionally a summary.
 *
 * Nothing here is derived. If the payload did not say it, this row does not carry it.
 */
export interface JobDimensionRow {
  name: string;
  /** The dimension's OWN status word, exactly as the producer wrote it (trimmed). */
  status: string;
  /** Only when the payload carried a non-empty string: absent means absent, never "". */
  summary?: string;
}

/**
 * The renderable rows of a job's `dimensions` array, in the producer's order.
 *
 * Tolerance is a rule here, not a defensive habit. The array is external, so a non-array,
 * an entry that is not an object, a missing `name`, or a non-string `status` are all
 * shapes that can arrive, and every one of them must produce a row that is missing rather
 * than a row that lies or a throw that blanks the whole panel.
 *
 * An entry survives when it carries a non-blank string `name` AND a non-blank string
 * `status` — those two are the row. `summary` is the one field a row can live without, so
 * a non-string or blank summary drops the summary line and keeps the dimension: hiding a
 * reported result because of its prose would be the opposite of the rule.
 *
 * An empty result means "nothing to add": the fixed `ingest`/`compile` sections render on
 * every job regardless, as the union the panel is built on - so an empty array and an
 * unusable one are the same fact here: no extra row, and nothing lost.
 *
 * Names are NOT deduplicated and NOT reordered: repetition and order are the payload's.
 */
export function dimensionRows(job: Pick<IngestJob, "dimensions">): JobDimensionRow[] {
  const raw = job.dimensions;
  if (!Array.isArray(raw)) return [];

  const rows: JobDimensionRow[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const status = typeof record.status === "string" ? record.status.trim() : "";
    if (name === "" || status === "") continue;
    const summary = typeof record.summary === "string" ? record.summary.trim() : "";
    rows.push(summary === "" ? { name, status } : { name, status, summary });
  }
  return rows;
}

/**
 * Whether the compile will never run because the ingest that feeds it failed.
 *
 * Verified against the live service: a job whose ingest fails keeps `compile` at
 * `queued` with a frozen `updatedAt` forever — nothing will ever start it. Rendering
 * that as "Working" is an indeterminate bar animating for a job that is dead, which
 * is the one thing this surface must never do: invent progress.
 *
 * The compile is not "failed", because it never ran. It is blocked by something that
 * already failed, and the honest word is the difference between a user waiting and a
 * user acting.
 */
export function compileBlockedByIngestFailure(job: IngestJob): boolean {
  return (
    job.ingest.status === "failed" &&
    (job.compile.status === "queued" || job.compile.status === "skipped")
  );
}

/**
 * The single line a job reduces to in a list.
 *
 * Deliberately not a status: it names which half is still moving, because
 * "Ingesting", "Compiling" and "Compile failed (source is saved)" lead to
 * different user actions.
 */
export function describeJob(job: IngestJob): string {
  if (job.ingest.status === "failed") return "Ingest failed";
  if (job.ingest.status === "queued") return "Waiting to start";
  if (job.ingest.status === "running") return `Ingesting · ${stageLabel(job.ingest.stage)}`;

  const ingestDone = job.ingest.status === "unchanged" ? "Unchanged" : "Source saved";
  switch (job.compile.status) {
    case "queued":
      return `${ingestDone} · compile queued`;
    case "running":
      return `${ingestDone} · compiling · ${stageLabel(job.compile.stage)}`;
    case "succeeded":
      return `${ingestDone} · compiled`;
    case "busy":
      // Not a failure: the source is on disk, only the compile needs a retry.
      return `${ingestDone} · compile busy — retry the compile`;
    case "skipped":
      return `${ingestDone} · compile skipped`;
    case "failed":
      return `${ingestDone} · compile failed`;
    default:
      return ingestDone;
  }
}

/**
 * Human text for a stage.
 *
 * The stages are the pipeline's own boundaries, so this is a presentation of the
 * same vocabulary rather than a friendlier renaming: a stage that is not measured
 * can never be displayed.
 */
export function stageLabel(stage: string | undefined): string {
  switch (stage) {
    case "detecting":
      return "detecting source type";
    case "fetching":
      return "fetching";
    case "extracting":
      return "extracting content";
    case "preparing":
      return "preparing";
    case "committing":
      return "committing";
    case "projecting":
      return "projecting";
    case "journaling":
      return "journalling";
    case "detect_changes":
      return "detecting changes";
    case "extraction":
      return "extraction";
    case "page_generation":
      return "generating pages";
    case "finalize":
      return "finalizing";
    case "embeddings":
      return "embeddings";
    case "queued":
      return "queued";
    case undefined:
      return "waiting";
    default:
      // A stage this build does not know is shown as itself rather than hidden:
      // hiding it would describe work that did not happen.
      return stage;
  }
}

/**
 * Whether a compile can be retried WITHOUT re-ingesting.
 *
 * The answer depends on BOTH halves, not on the compile alone. `busy` and `failed`
 * leave the compile work outstanding, but "retry the compile" is only true advice if
 * the ingest actually stored the source — and a job whose ingest failed has nothing on
 * disk to compile. Verified against real jobs: a lock-contention failure reports
 * `ingest: failed` with `compile: busy` and the message "Compile did not start", so a
 * check on the compile status alone tells the user "the source is saved" directly
 * beneath a message saying the compile never started. Reading one half and asserting
 * about both is the same defect this surface already had twice today.
 *
 * `unchanged` counts as stored: the source is already in the wiki, which is why the
 * compile still has work to do.
 */
export function compileRetryable(job: IngestJob): boolean {
  const sourceStored =
    job.ingest.status === "succeeded" || job.ingest.status === "unchanged";
  const compileOutstanding =
    job.compile.status === "busy" || job.compile.status === "failed";
  return sourceStored && compileOutstanding;
}

/** How long a snapshot may stay byte-identical before the job is called stalled. */
export const STALL_AFTER_MS = 90_000;

/**
 * True when `snapshot` has not advanced since `previous`.
 *
 * Compares `updatedAt`, which the service writes on every transition, so a job
 * that is genuinely working always looks different. Anything derived from wall
 * clock on the client would break across a tab being throttled in the background.
 */
export function isUnchanged(previous: IngestJob | undefined, snapshot: IngestJob): boolean {
  if (!previous) return false;
  return previous.updatedAt === snapshot.updatedAt;
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

/**
 * Leading 404s tolerated before a job is called unknown.
 *
 * Three reads at 250/500/1000 ms; beyond that a 404 is the truth. Bounded on
 * purpose: an unbounded tolerance would make an expired job look like a slow one
 * forever.
 *
 * MEASURED on a live host: the fire-and-forget mirror lands in 71-72 ms (three runs),
 * so the first read at 250 ms already sees it. This tolerance is headroom against a
 * loaded host, not the normal path.
 *
 * ONE BOUNDARY WORTH KNOWING: for a Stack that is NOT the endpoint's bound one, the
 * service serves durable rows only — its live registry is stack-agnostic and merging
 * it would attribute this host's jobs to another Stack. So nothing bridges the gap
 * and this tolerance IS the whole wait. A foreign-Stack job that appears late is that
 * fact showing through, not a bug: another process's memory cannot be read from here.
 */
export const MISSING_TOLERANCE = 3;

/** First delay: fast enough that a short job does not visibly stall. */
export const POLL_INITIAL_MS = 250;

/** Ceiling: a long compile must not hammer the host. */
export const POLL_MAX_MS = 2_000;

/** Next delay in the 250 ms -> 2 s backoff. */
export function nextPollDelay(current: number): number {
  return Math.min(current * 2, POLL_MAX_MS);
}

/**
 * Why a poll loop can stop.
 *
 * `unavailable` and `unknown` are kept apart on purpose. `503` means the service
 * does not track jobs at all — a deployment fact that may change, and the job may
 * well exist regardless. `404` means it tracks jobs and has never seen this id,
 * which is what an expired job looks like under the service's own retention.
 * Treating the first as the second would make the UI declare a live job dead.
 */
export type PollStopReason =
  | "settled"
  | "unavailable"
  | "unknown"
  | "aborted"
  | "error"
  /**
   * The job stopped moving and will not move again.
   *
   * Reachable now that the service persists job state: a process killed mid-job
   * leaves its last snapshot behind, frozen mid-pipeline. The mirror write is
   * fire-and-forget, so nothing ever rewrites that row to a terminal state. This is
   * not `settled` (both dimensions never finished) and not `error` (no request
   * failed); it is a job whose owner died, and the UI must say so rather than
   * spinning forever.
   */
  | "stalled";

export interface PollOutcome {
  reason: PollStopReason;
  /** Last snapshot seen, when one was. */
  job?: IngestJob;
  /** Message for the UI when the reason is a failure. */
  message?: string;
}

export interface PollOptions {
  baseUrl?: string;
  /** Which Stack to read. Absent means the endpoint's own. */
  stackId?: string;
  headers: () => Record<string, string>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Called with every snapshot, so the UI updates as it polls. */
  onUpdate: (job: IngestJob) => void;
  /** Injection seam for tests; defaults to a real timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** First delay, exposed so a test can prove the curve without waiting. */
  initialDelay?: number;
  /**
   * How long an unmoving snapshot is tolerated before the job is called stalled.
   * `Infinity` disables it, which is only correct for a test.
   */
  stallAfterMs?: number;
}

/** An error carrying the HTTP status, so the UI can tell 404 from 503. */
export class IngestRequestError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Follow one job until it settles, backing off from 250 ms to 2 s.
 *
 * Returns instead of throwing for every expected stop, because each one is a
 * state the UI must render: an expired job, a host without job tracking, and a
 * settled job are all outcomes, not exceptions.
 */
export async function pollJob(jobId: string, options: PollOptions): Promise<PollOutcome> {
  const baseUrl = options.baseUrl ?? "/api";
  const doFetch = options.fetchImpl ?? fetch.bind(globalThis);
  const sleep = options.sleep ?? defaultSleep;
  let delay = options.initialDelay ?? POLL_INITIAL_MS;
  const stallAfterMs = options.stallAfterMs ?? STALL_AFTER_MS;
  let last: IngestJob | undefined;
  // Monotonic and injected nowhere on purpose: this measures how long THIS loop
  // has watched an unchanged snapshot, which is a client-side fact, not a job
  // property. A job whose timestamp is old but which is still advancing here is
  // working fine.
  let unchangedSince: number | undefined;
  /**
   * How many leading 404s this loop has tolerated.
   *
   * A foreign-Stack read is served from durable rows only, and the mirror write is
   * fire-and-forget, so a job started a moment ago can be missing for a tick. An
   * immediate 404 therefore means "not landed yet" just as plausibly as "expired",
   * and stopping on the first one would report a job that is running as gone. A
   * 404 that PERSISTS is still expired, so the tolerance is bounded.
   */
  let missingReads = 0;

  for (;;) {
    if (options.signal?.aborted) return { reason: "aborted", ...(last ? { job: last } : {}) };

    let response: Response;
    try {
      const stack = options.stackId?.trim();
      const query = stack ? `?stackId=${encodeURIComponent(stack)}` : "";
      response = await doFetch(`${baseUrl}/ingest/jobs/${encodeURIComponent(jobId)}${query}`, {
        headers: options.headers(),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (isAbort(error)) return { reason: "aborted", ...(last ? { job: last } : {}) };
      return {
        reason: "error",
        message: messageOf(error),
        ...(last ? { job: last } : {}),
      };
    }

    if (response.status === 503) {
      // The host does not track jobs. NOT "no such job": that is the whole reason
      // the contract makes these two codes different.
      return {
        reason: "unavailable",
        message: "This host does not track ingest jobs, so the status cannot be read.",
        ...(last ? { job: last } : {}),
      };
    }
    if (response.status === 404) {
      // Tolerated only while NOTHING has been seen on this job: a snapshot that
      // arrived and then vanished is expired, not late. Bounded too, so an unknown id
      // is still reported rather than watched forever.
      const mayLag = last === undefined && missingReads < MISSING_TOLERANCE;
      if (!mayLag) {
        return {
          reason: "unknown",
          message:
            "This job is no longer known to the host. Settled jobs are kept for one hour " +
            "and at most 200 per host, so it may have expired.",
          ...(last ? { job: last } : {}),
        };
      }
      // Wait out the mirror write, then ask again.
      missingReads += 1;
      await sleep(delay, options.signal);
      delay = nextPollDelay(delay);
      continue;
    }

    if (!response.ok) {
      const body = await safeJson(response);
      return {
        reason: "error",
        message:
          typeof body?.message === "string"
            ? body.message
            : `The server answered ${response.status}.`,
        ...(last ? { job: last } : {}),
      };
    }

    const job = (await response.json()) as IngestJob;
    const moved = !isUnchanged(last, job);
    last = job;
    options.onUpdate(job);

    if (isJobSettled(job)) return { reason: "settled", job };

    // A snapshot that has not advanced for long enough is not slow, it is orphaned:
    // the process that owned it is gone and nothing will ever finish it.
    const now = Date.now();
    if (moved) {
      unchangedSince = undefined;
    } else if (unchangedSince === undefined) {
      unchangedSince = now;
    } else if (now - unchangedSince >= stallAfterMs) {
      return {
        reason: "stalled",
        job,
        message:
          "This job has not moved for a while, which usually means the process " +
          "running it stopped mid-way. Its last state is shown below; it will not advance.",
      };
    }
    // An abort that arrived while this read was in flight must not schedule
    // another wait: the view it was polling for is gone.
    if (options.signal?.aborted) return { reason: "aborted", job };

    await sleep(delay, options.signal);
    delay = nextPollDelay(delay);
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function safeJson(response: Response): Promise<{ message?: unknown; error?: unknown } | undefined> {
  try {
    return (await response.json()) as { message?: unknown; error?: unknown };
  } catch {
    return undefined;
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"));
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
