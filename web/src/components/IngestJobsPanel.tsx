import { useState, type ChangeEvent, type FormEvent } from "react";
import { describeJob, isJobSettled } from "../lib/ingest.ts";
import { UNRESOLVED_STACK_ID_NOTICE, type UseIngestResult } from "../lib/use-ingest.ts";
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

  // The Stack every write from this panel belongs to. Never derived here: the hook owns
  // the order (choice first, link as fallback) so there is exactly one precedence rule.
  const stackId = ingest.resolvedStackId;

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
    // The chosen Stack travels with the write; `undefined` only when nothing resolved,
    // and then the panel is not offering this form at all.
    void ingest.start(trimmed, { compile, stackId: stackId ?? undefined });
    setSource("");
  };

  /*
    The Stack control. Options come from the host (`GET /stacks` through the hook) and
    always include the link's own value, so the page is usable before the list answers
    or when the host cannot list. The empty option exists ONLY while nothing is
    resolved: with a Stack chosen there is no "none" to go back to, and an empty value
    would name a Stack called "".
  */
  const stackField = (
    <label className="jobs-panel__field">
      <span className="jobs-panel__label">Stack</span>
      <select
        className="jobs-panel__input"
        value={stackId ?? ""}
        onChange={(event) => ingest.chooseStackId(event.target.value)}
        aria-label="Stack"
      >
        {stackId === null && <option value="">Choose a Stack…</option>}
        {ingest.stackIds.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
    </label>
  );

  const form = (
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
      {stackField}
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
  );

  const header = (
    <header className="jobs-panel__header">
      <h2 className="jobs-panel__title">Ingest jobs</h2>
      <button type="button" className="button button--small" onClick={onClose}>
        Back to chat
      </button>
    </header>
  );

  // No tenant in the link means no ingest READS: no upload, no document list and no job
  // list, because every one of those would either read another Stack or fail in a way
  // the user cannot act on. What stays is the choice S4 names — a Stack picked here
  // scopes the ingest this panel starts — so the surface is not a dead end. Without a
  // resolved Stack there is no form at all: nothing to submit into, and nothing that
  // would send a request nobody named. The chat itself stays available; the block is
  // scoped to ingest, not to the session.
  if (ingest.blockedProblem) {
    return (
      <main className="jobs-panel">
        {header}
        <section aria-label="Stack required">
          <h3 className="jobs-panel__subtitle">This link has no Stack</h3>
          {/* The one ANNOUNCED notice: the read block, which names the link. */}
          <p className="jobs-panel__notice jobs-panel__notice--warn" role="alert">
            {ingest.blockedProblem}
          </p>
          {stackField}
          {/*
            The write block, stated but not announced: it describes the state the control
            above is in, not an event that just happened. Same S4 copy the hook reports,
            reused here rather than rewritten.
          */}
          {stackId === null && (
            <p className="jobs-panel__notice jobs-panel__notice--warn">
              {UNRESOLVED_STACK_ID_NOTICE}
            </p>
          )}
          {stackId !== null && form}
        </section>
      </main>
    );
  }

  return (
    <main className="jobs-panel">
      {header}

      {/*
        Upload and ingest are separate steps on purpose. A document is a resource
        with its own identity: it can be ingested again after a failed compile
        without being uploaded twice, and a file can be stored before anyone decides
        whether it belongs in the wiki.
      */}
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
                  onClick={() =>
                    void ingest.ingestDocument(document.id, {
                      compile,
                      stackId: stackId ?? undefined,
                    })
                  }
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

      {form}

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
