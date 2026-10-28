import { useState, type FormEvent } from "react";
import { describeJob, isJobSettled } from "../lib/ingest.ts";
import type { UseIngestResult } from "../lib/use-ingest.ts";
import { IngestJobView } from "./IngestJobView.tsx";

export interface IngestJobsPanelProps {
  ingest: UseIngestResult;
  onClose(): void;
}

/**
 * The ingest-status surface: start a job, watch it, read what happened.
 *
 * Every notice here names which fact produced it, because the three failure-ish
 * notices need different responses:
 *
 *  - "not tracked" (503) — the host was started without a project root. The job
 *    is not necessarily gone, so this must not read as "your upload vanished".
 *  - "expired" (404) — the job existed and aged out of the 1 h / 200-entry
 *    retention window.
 *  - "busy" (409) — one ingest at a time; retry shortly.
 */
export function IngestJobsPanel({ ingest, onClose }: IngestJobsPanelProps) {
  const [source, setSource] = useState("");
  const [compile, setCompile] = useState(true);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = source.trim();
    if (!trimmed) return;
    void ingest.start(trimmed, { compile });
    setSource("");
  };

  return (
    <main className="jobs-panel">
      <header className="jobs-panel__header">
        <h2 className="jobs-panel__title">Ingest jobs</h2>
        <button type="button" className="button button--small" onClick={onClose}>
          Back to chat
        </button>
      </header>

      <form className="jobs-panel__form" onSubmit={submit}>
        <label className="jobs-panel__field">
          <span className="jobs-panel__label">Source</span>
          <input
            className="jobs-panel__input"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder="https://example.com/article  or  a path on the source host"
            aria-label="Source"
          />
        </label>
        <label className="jobs-panel__checkbox">
          <input
            type="checkbox"
            checked={compile}
            onChange={(event) => setCompile(event.target.checked)}
          />
          <span>Compile after ingesting</span>
        </label>
        <button
          type="submit"
          className="button button--primary"
          disabled={ingest.starting || source.trim().length === 0}
        >
          {ingest.starting ? "Starting…" : "Start ingest"}
        </button>
      </form>

      {/*
        A path is resolved on the machine running the ingest service, not in this
        container, so a file that only exists here is not a valid source. Said once,
        in place, instead of being discovered as a confusing 404.
      */}
      <p className="jobs-panel__hint">
        A path is resolved on the machine that runs the ingest service, not inside this
        application. Use a URL, or a path the service can see.
      </p>

      {ingest.listNotice && (
        <p className="jobs-panel__notice jobs-panel__notice--warn" role="status">
          {ingest.listNotice.message}
        </p>
      )}

      {ingest.pollNotice && (
        <div className="jobs-panel__notice jobs-panel__notice--warn" role="alert">
          <span>{ingest.pollNotice.message}</span>
          <button
            type="button"
            className="button button--small"
            onClick={ingest.clearPollNotice}
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="jobs-panel__body">
        <section className="jobs-panel__list" aria-label="Recent jobs">
          <h3 className="jobs-panel__subtitle">
            Recent
            <button
              type="button"
              className="button button--small"
              onClick={() => void ingest.refreshList()}
            >
              Refresh
            </button>
          </h3>

          {ingest.loadingList ? (
            <p className="jobs-panel__empty">Loading…</p>
          ) : ingest.jobs.length === 0 ? (
            <p className="jobs-panel__empty">No jobs yet.</p>
          ) : (
            <ul className="job-list">
              {ingest.jobs.map((job) => (
                <li key={job.id}>
                  <button
                    type="button"
                    className={`job-list__row${job.id === ingest.activeId ? " job-list__row--active" : ""}`}
                    onClick={() => ingest.follow(job.id)}
                    title={job.source}
                  >
                    <span className="job-list__summary">{describeJob(job)}</span>
                    <span className="job-list__meta">
                      <code>{job.id}</code>
                      {/* A closed job is a fact about the poll, not a status of
                          the job, so it is a separate word. */}
                      {!isJobSettled(job) && <span className="job-list__live">live</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="jobs-panel__detail" aria-label="Job detail">
          {ingest.activeJob ? (
            <>
              {ingest.following && (
                <p className="jobs-panel__following" role="status">
                  <span className="spinner" aria-hidden="true" />
                  Updating automatically…
                </p>
              )}
              <IngestJobView job={ingest.activeJob} />
            </>
          ) : (
            <p className="jobs-panel__empty">
              Start an ingest, or pick a job from the list to follow it.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
