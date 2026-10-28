import { useState, type ChangeEvent, type FormEvent } from "react";
import { describeJob, isJobSettled } from "../lib/ingest.ts";
import type { UseIngestResult } from "../lib/use-ingest.ts";
import { IngestJobView } from "./IngestJobView.tsx";

/** Byte counts a person can read at a glance. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024) } KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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

  const pick = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Clear the input so picking the SAME file twice still fires a change: a user
    // who deletes an upload and re-adds it must not be blocked by a browser that
    // thinks nothing changed.
    event.target.value = "";
    if (file) void ingest.upload(file);
  };

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

      {/*
        Upload and ingest are separate steps on purpose. A document is a resource
        with its own identity: it can be ingested again after a failed compile
        without being uploaded twice, and a file can be stored before anyone decides
        whether it belongs in the wiki.
      */}
      {/*
        The stack list arrives from the AGENT, so this picker can be empty until a
        turn asked for it. That is stated rather than hidden: an empty dropdown with
        no explanation reads as a bug.
      */}
      <section className="jobs-panel__stacks" aria-label="Stack selection">
        <label className="jobs-panel__stackfield" htmlFor="stack-select">
          <span className="jobs-panel__label">Stack</span>
          <select
            id="stack-select"
            className="jobs-panel__select"
            value={ingest.selectedStackId ?? ""}
            onChange={(event) => ingest.selectStack(event.target.value || null)}
            disabled={ingest.stacks.length === 0}
          >
            {ingest.stacks.length === 0 && <option value="">No stacks known yet</option>}
            {ingest.stacks.map((stack) => (
              <option key={stack.id} value={stack.id}>
                {stack.name}
                {stack.isCurrent ? " (bound)" : ""}
              </option>
            ))}
          </select>
        </label>
        {ingest.stacksProblem && (
          <p className="jobs-panel__notice jobs-panel__notice--warn" role="alert">
            {ingest.stacksProblem}
          </p>
        )}
        {ingest.stacks.length === 0 && !ingest.stacksProblem && (
          <p className="jobs-panel__hint">
            Ask the assistant to list the stacks and they will appear here.
          </p>
        )}
      </section>

      <section className="jobs-panel__upload" aria-label="Upload a document">
        <label className="jobs-panel__filebutton">
          <input
            type="file"
            onChange={pick}
            disabled={ingest.uploading}
            aria-label="Choose a document"
          />
          <span className="button">{ingest.uploading ? "Uploading…" : "Choose a document"}</span>
        </label>
        <p className="jobs-panel__hint">
          The file is stored here and then handed to the ingest service by URL. Its
          extension decides how it is parsed, so keep it.
        </p>
      </section>

      {ingest.documentsNotice && (
        <p className="jobs-panel__notice jobs-panel__notice--warn" role="alert">
          {ingest.documentsNotice.message}
        </p>
      )}

      <section className="jobs-panel__documents" aria-label="Uploaded documents">
        <h3 className="jobs-panel__subtitle">Uploaded</h3>
        {ingest.documents.length === 0 ? (
          <p className="jobs-panel__empty">No documents uploaded yet.</p>
        ) : (
          <ul className="document-list">
            {ingest.documents.map((document) => (
              <li key={document.id} className="document-list__row">
                <span className="document-list__name" title={document.filename}>
                  {document.filename}
                </span>
                <span className="document-list__meta">{formatBytes(document.bytes)}</span>
                <button
                  type="button"
                  className="button button--small"
                  onClick={() => void ingest.ingestDocument(document.id, { compile })}
                >
                  Ingest
                </button>
                <button
                  type="button"
                  className="button button--small"
                  aria-label={`Delete ${document.filename}`}
                  onClick={() => void ingest.removeDocument(document.id)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

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
        For a reference instead of an upload: a URL is fetched by the ingest service,
        and a path is resolved on the machine that runs it, not inside this
        application.
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
