import {
  compileBlockedByIngestFailure,
  compileRetryable,
  isCompileSettled,
  isIngestSettled,
  stageLabel,
  type CompileDimension,
  type IngestDimension,
  type IngestJob,
} from "../lib/ingest.ts";

export interface IngestJobViewProps {
  job: IngestJob;
}

/**
 * One job, as two independent columns.
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
 */
export function IngestJobView({ job }: IngestJobViewProps) {
  const blockedCompile = compileBlockedByIngestFailure(job);

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
          <StageRow stage={job.ingest.stage} />
          {job.ingest.message && <p className="dimension__message">{job.ingest.message}</p>}
          {job.ingest.error && (
            <p className="dimension__error" role="alert">
              {job.ingest.error}
            </p>
          )}
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
          <StageRow stage={job.compile.stage} />
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
          {job.compile.message && <p className="dimension__message">{job.compile.message}</p>}
          {job.compile.error && (
            <p className="dimension__error" role="alert">
              {job.compile.error}
            </p>
          )}
          {compileRetryable(job.compile) && (
            <p className="dimension__hint">
              {job.compile.status === "busy"
                ? "The source is saved. Only the compile needs a retry."
                : "The source is saved. Re-run the compile to finish the wiki."}
            </p>
          )}
        </section>
      </div>
    </section>
  );
}

function StatusBadge({
  status,
  settled,
  tone,
}: {
  status: string;
  settled: boolean;
  /** Overrides the tone derived from the status alone, when the status is ambiguous. */
  tone?: string | undefined;
}) {
  return (
    <span
      className={`badge badge--${tone ?? badgeTone(status)}`}
      data-status={status}
      data-settled={settled ? "true" : "false"}
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

function StageRow({ stage }: { stage: string | undefined }) {
  return (
    <p className="dimension__stage">
      <span className="dimension__stage-label">Stage</span>
      {/* Never blank: "waiting" is a statement, an empty row is a mystery. */}
      <span className="dimension__stage-value" data-testid="stage">
        {stageLabel(stage)}
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
