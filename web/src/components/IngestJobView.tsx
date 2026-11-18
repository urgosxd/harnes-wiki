import {
  compileBlockedByIngestFailure,
  compileRetryable,
  dimensionRows,
  isCompileSettled,
  isIngestSettled,
  stageLabel,
  type CompileDimension,
  type IngestDimension,
  type IngestJob,
  type JobDimensionRow,
} from "../lib/ingest.ts";

export interface IngestJobViewProps {
  job: IngestJob;
}

/**
 * One job, as two fixed columns PLUS the payload's own breakdown.
 *
 * ## Why two columns and not one status
 *
 * An ingest and its compile fail separately. A job whose source landed and whose
 * compile is `busy` is a normal state: retrying the upload would be wrong, and
 * labelling the job "failed" would cause exactly that. Two columns make the
 * split visible without the reader having to know the contract.
 *
 * ## What this component refuses to do
 *
 *  - It never computes a percentage. `progress: null` renders an indeterminate
 *    bar plus the stage name; an exact pair renders "3 of 8" and a bar. Nothing
 *    is derived from a stage that never counted anything.
 *  - It never hides an attempt. An attempt without `endedAt` is shown as in
 *    flight, and one with `error` is shown as rolled back.
 *  - It never renders an unknown stage as blank: the raw name is shown.
 *  - It never renders a value the payload did not carry: an absent `endedAt`
 *    drops the line instead of showing a placeholder that would read as data.
 *
 * ## The fixed pair ALWAYS renders, and the payload's rows join it
 *
 * `ingest` and `compile` are the job's two state machines - status, stage, attempts,
 * progress - and `dimensions` is a per-output breakdown of what the run produced. They
 * answer different questions, so one does not replace the other: the panel renders the
 * two fixed sections on every job, and appends a row per dimension when the payload
 * carries a usable array.
 *
 * This used to be a branch: when `dimensions` was non-empty the fixed sections were
 * dropped. A real payload ended that rule. `compile` was still `running` on
 * `page_generation` at 0 of 43 pages while `dimensions` already reported `wiki` and `kg`
 * as `succeeded`, so the array - a report about finished outputs - hid the only row that
 * said what the job was doing right then. The user had to reload the page to see it.
 *
 * The one thing NOT shown twice is a dimension that merely repeats a fixed section's name:
 * the fixed section already carries that row, and a second copy would leave the reader
 * choosing which to trust. A dimension's badge stays its OWN status either way, so a
 * failed `kg` under a `succeeded` compile is visibly failed.
 */
export function IngestJobView({ job }: IngestJobViewProps) {
  const blockedCompile = compileBlockedByIngestFailure(job);
  // The breakdown rows only: `dimensionRows` has already dropped everything it could not
  // read, and `breakdownRows` drops the names a fixed section owns.
  const breakdown = breakdownRows(job);

  return (
    <section className="job" aria-label={`Ingest job ${job.id}`}>
      <header className="job__header">
        <code className="job__id">{job.id}</code>
        <span className="job__source" title={job.source}>
          {job.source}
        </span>
      </header>

      <div className="job__dimensions">
        <section
          className="dimension"
          aria-label="Ingest"
          data-testid="dimension-ingest"
        >
          <h3 className="dimension__title">
            Ingest
            <StatusBadge status={job.ingest.status} settled={isIngestSettled(job.ingest)} />
          </h3>
          <StageRow stage={job.ingest.stage} status={job.ingest.status} />
          {job.ingest.message && <p className="dimension__message">{job.ingest.message}</p>}
          {job.ingest.error && (
            <p className="dimension__error" role="alert">
              {job.ingest.error}
            </p>
          )}
          <FinishedAt endedAt={job.ingest.endedAt} />
          <AttemptList attempts={job.ingest.attempts} />
        </section>

        <section
          className="dimension"
          aria-label="Compile"
          data-testid="dimension-compile"
        >
          <h3 className="dimension__title">
            Compile
            {/*
              `skipped` reads as success in the tone map, and usually it is. But a
              compile that never started because the ingest failed is not a success,
              and nothing about the status word says which one this is — only the
              ingestion outcome does. Colour is a second channel saying "fine", so
              leaving it green would contradict the words directly beneath it.
            */}
            <StatusBadge
              status={job.compile.status}
              settled={isCompileSettled(job.compile)}
              tone={blockedCompile ? "idle" : undefined}
            />
          </h3>
          <StageRow stage={job.compile.stage} status={job.compile.status} />
          {/*
            No progress indicator when the compile can never start: an animated
            indeterminate bar reads as "working", and the ingest that feeds this stage
            already failed. The absence of motion is the message.
          */}
          {blockedCompile ? (
            <p className="dimension__hint" data-testid="compile-blocked">
              The compile never started: the ingest it depends on failed. Saving the
              source again is what clears this, not waiting.
            </p>
          ) : (
            <ProgressIndicator compile={job.compile} />
          )}
          {/*
            Counts that do not fit the ratio, shown as text beside it and NEVER
            merged into it: `progress` is pages, `detail` is chunks and requests, and
            adding them would be the invented progress this view refuses. Absent means
            absent - a stage that never published chunks says nothing rather than "0".
          */}
          {detailLine(job.compile.detail) && (
            <p className="dimension__hint" data-testid="compile-detail">
              {detailLine(job.compile.detail)}
            </p>
          )}
          {job.compile.message && (
            <p className="dimension__message">{job.compile.message}</p>
          )}
          {job.compile.error && (
            <p className="dimension__error" role="alert">
              {job.compile.error}
            </p>
          )}
          <FinishedAt endedAt={job.compile.endedAt} />
          {compileRetryable(job) && (
            <p className="dimension__hint">
              {job.compile.status === "busy"
                ? "The source is saved. Only the compile needs a retry."
                : "The source is saved. Re-run the compile to finish the wiki."}
            </p>
          )}
        </section>

        {/* The producer's order is the pipeline's order; the index is only there so
            two dimensions that share a name cannot collide as keys. */}
        {breakdown.map((dimension, index) => (
          <DimensionRow key={`${index}:${dimension.name}`} dimension={dimension} />
        ))}
      </div>
    </section>
  );
}

/**
 * The names the two fixed sections own.
 *
 * Compared trimmed and case-insensitively, because the producer's capitalisation is not a
 * promise: `Ingest`, `ingest` and ` INGEST ` are the same row to a reader.
 */
const FIXED_SECTION_NAMES = new Set(["ingest", "compile"]);

/**
 * The dimensions that are NOT already covered by a fixed section.
 *
 * `dimensionRows` narrows the payload entry by entry; this drops only the rows whose name
 * a fixed section already renders. Nothing else is filtered, reordered or merged - order
 * and repetition among the remaining rows stay the payload's.
 */
function breakdownRows(job: IngestJob): JobDimensionRow[] {
  return dimensionRows(job).filter(
    (dimension) => !FIXED_SECTION_NAMES.has(dimension.name.toLowerCase()),
  );
}

/**
 * When the state machine closed, and only when the payload said so.
 *
 * No value, no line: a timestamp the page invented is worse than a missing one, because a
 * reader cannot tell the difference later. The raw value is rendered as it arrived rather
 * than reformatted, so the line cannot disagree with the payload or change with the
 * reader's timezone.
 */
function FinishedAt({ endedAt }: { endedAt: string | undefined }) {
  if (typeof endedAt !== "string" || endedAt === "") return null;
  return (
    <p className="dimension__hint" data-testid="finished-at">
      Closed <time dateTime={endedAt}>{endedAt}</time>
    </p>
  );
}

/**
 * One dimension the payload reported.
 *
 * Deliberately NOT the fixed column: no stage row, no progress bar, no attempt list,
 * because the producer publishes none of those per dimension. Deriving them from the
 * overall job would be the fabricated state the fixed columns already refuse to show.
 *
 * No `data-settled` either: that attribute says "this state machine is finished", and a
 * dimension's vocabulary is the producer's, not the `ingest`/`compile` pair this module
 * knows. A word this build does not recognise is shown as itself and claimed terminal by
 * nobody - the same rule as an unknown stage.
 */
function DimensionRow({ dimension }: { dimension: JobDimensionRow }) {
  return (
    <section
      className="dimension"
      aria-label={dimension.name}
      data-testid="dimension-row"
      data-dimension={dimension.name}
    >
      <h3 className="dimension__title">
        {dimension.name}
        {/* This dimension's OWN status, never the job's overall one. */}
        <StatusBadge status={dimension.status} />
      </h3>
      {/* Absent means absent: a dimension that published no summary says nothing. */}
      {dimension.summary !== undefined && (
        <p className="dimension__message" data-testid="dimension-summary">
          {dimension.summary}
        </p>
      )}
    </section>
  );
}

function StatusBadge({
  status,
  settled,
  tone,
}: {
  status: string;
  /**
   * Whether the state machine this status belongs to is finished.
   *
   * Omitted for a dimension row: the vocabulary there is the producer's, and calling a
   * word terminal on a state machine this build does not know would be a guess wearing an
   * attribute that reads like a fact.
   */
  settled?: boolean;
  /** Overrides the tone derived from the status alone, when the status is ambiguous. */
  tone?: string | undefined;
}) {
  return (
    <span
      className={`badge badge--${tone ?? badgeTone(status)}`}
      data-status={status}
      {...(settled === undefined ? {} : { "data-settled": settled ? "true" : "false" })}
    >
      {status}
    </span>
  );
}

/**
 * Tone, not meaning: the word itself is always rendered, so colour is never the
 * only channel that carries the state.
 */
function badgeTone(status: string): string {
  if (status === "failed") return "bad";
  if (status === "busy") return "warn";
  if (status === "succeeded" || status === "unchanged" || status === "skipped") return "good";
  if (status === "running") return "active";
  return "idle";
}

/**
 * Where the work is, or where it stopped.
 *
 * `stage` records the last stage the run reached, and on a SETTLED job it is a
 * residue: `status: succeeded` with `stage: embeddings` does not mean "still
 * embedding", it means "finished, and embeddings was the last thing it touched".
 * Rendering it unqualified on a finished job reads as "it is in embeddings now" -
 * reported by the user as a UI bug on a compile that had already succeeded.
 *
 * So a finished job says `final`, not a step name. The stage still matters while the
 * run is live, and it still matters after a FAILURE - knowing it died in embeddings
 * rather than extraction is the useful part - so only `succeeded` is relabelled.
 */
function StageRow({
  stage,
  status,
}: {
  stage: string | undefined;
  status: string;
}) {
  const finished = status === "succeeded";
  return (
    <p className="dimension__stage">
      <span className="dimension__stage-label">{finished ? "Reached" : "Stage"}</span>
      {/* Never blank: "waiting" is a statement, an empty row is a mystery. */}
      <span className="dimension__stage-value" data-testid="stage">
        {finished ? "final" : stageLabel(stage)}
      </span>
    </p>
  );
}

/**
 * Indeterminate when the denominator is unknown.
 *
 * The contract is explicit that only `page_generation` and `finalize` carry a
 * real total, so `null` is the common case and must look deliberate rather than
 * broken.
 */
/**
 * Chunks and requests, when the producer published them.
 *
 * `undefined` and `0` are different facts and this renders the difference: a missing
 * count says nothing, a real zero is stated. The producer omits zeros for the same
 * reason, so a zero here is a genuine measurement rather than a default.
 */
function detailLine(detail: CompileDimension["detail"]): string | null {
  if (detail === undefined) return null;
  const parts: string[] = [];
  if (detail.chunks !== undefined) {
    parts.push(`${detail.chunks} ${detail.chunks === 1 ? "chunk" : "chunks"}`);
  }
  if (detail.requests !== undefined) {
    parts.push(`${detail.requests} ${detail.requests === 1 ? "request" : "requests"}`);
  }
  return parts.length > 0 ? `Embedded ${parts.join(" in ")}` : null;
}

function ProgressIndicator({ compile }: { compile: CompileDimension }) {
  // A bar only means something while the work is MOVING. An animation on a settled
  // compile invents motion for a job that already ended, which is the one thing this
  // surface must not do — and it is not only the blocked case: `skipped` and `failed`
  // also arrive with `progress: null`, so a guard on `queued` alone was fixing one
  // instance of a rule violation instead of the rule. Settled states say what
  // happened in words; there is nothing left to measure.
  if (isCompileSettled(compile)) return null;

  if (compile.progress === null) {
    return (
      <div className="progress" data-testid="progress-indeterminate">
        <div className="progress__bar progress__bar--indeterminate" aria-hidden="true">
          <span className="progress__fill" />
        </div>
        <p className="progress__label">
          Working — this stage does not report a total
        </p>
      </div>
    );
  }

  const { completed, total } = compile.progress;

  // A bar reaching 100% while the stage is still RUNNING says "finished" at the exact
  // moment the user is waiting - worse than no bar, because it is confidently wrong
  // rather than visibly stuck. Two ways to arrive there:
  //
  //   - a one-unit total (a single source compiles 0/1 -> 1/1), where a ratio of one
  //     has no width to communicate anything;
  //   - a single settled BATCH, which the producer documents: the provider answers a
  //     batch atomically, so with the default batch size a whole stage jumps straight
  //     to N/N while the stage is still closing. That is correct upstream and must not
  //     be read as a stall - but it must not be drawn as completion either.
  //
  // The numbers stay either way. This withholds only the bar; the pair is real and is
  // still shown, so it is not the fabricated null this surface refuses.
  //
  // The trailing marker is what stops "109 of 109" reading as a frozen "=". The
  // counters reach the total while the stage is still closing (a batch lands
  // atomically, and the tail work - flush, index write, settle - has no counter of
  // its own). Without a word saying it is still working, a complete-looking pair on a
  // RUNNING stage reads as stuck, and the user rightly asks why nothing is happening.
  if (total <= 1 || completed >= total) {
    return (
      <div className="progress" data-testid="progress-counted">
        <p className="progress__label">
          {completed} of {total}
          <span className="progress__pending" aria-live="polite">
            {completed >= total ? " — still working" : ""}
          </span>
        </p>
      </div>
    );
  }

  // Guard against a nonsensical pair rather than rendering 250%: a total of 0
  // cannot produce a width, so the bar is left empty and the numbers speak.
  const percent = total > 0 ? Math.min(100, Math.max(0, Math.round((completed / total) * 100))) : 0;

  return (
    <div className="progress" data-testid="progress-exact">
      <div
        className="progress__bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={completed}
        aria-label="Compile progress"
      >
        <span className="progress__fill" style={{ width: `${percent}%` }} />
      </div>
      <p className="progress__label">
        {completed} of {total}
      </p>
    </div>
  );
}

/**
 * Every transaction attempt, in order.
 *
 * The pipeline already retries inside the mutation lock; this makes that retry
 * loop visible instead of adding a policy of its own. An attempt with no
 * `endedAt` is in flight; one with `error` rolled back.
 */
function AttemptList({ attempts }: { attempts: IngestDimension["attempts"] }) {
  if (attempts.length === 0) {
    return <p className="attempts attempts--empty">No attempts yet.</p>;
  }

  return (
    <ol className="attempts" aria-label="Attempts">
      {attempts.map((attempt) => {
        const inFlight = attempt.endedAt === undefined;
        const rolledBack = attempt.error !== undefined;
        return (
          <li
            key={attempt.attempt}
            className={`attempt${rolledBack ? " attempt--rolled-back" : ""}`}
            data-in-flight={inFlight ? "true" : "false"}
          >
            <span className="attempt__number">#{attempt.attempt}</span>
            {inFlight ? (
              <span className="attempt__state">
                <span className="spinner" aria-hidden="true" />
                in flight
              </span>
            ) : rolledBack ? (
              <span className="attempt__state">rolled back</span>
            ) : (
              <span className="attempt__state">done</span>
            )}
            {rolledBack && <span className="attempt__error">{attempt.error}</span>}
          </li>
        );
      })}
    </ol>
  );
}
