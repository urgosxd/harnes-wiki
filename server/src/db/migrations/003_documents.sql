-- Uploaded documents: a resource with its own identity, referenced instead of
-- re-sent.
--
-- ## Why a table and not a volume
--
-- The bytes have to live somewhere both this server and the ingest service can
-- reach. Postgres is already the single source of truth for everything else here
-- (conversations, transcript, runs), and a second storage root would mean a second
-- thing to back up, restore and keep in sync. A bytea column is the boring answer,
-- and boring is what a document store should be.
--
-- ## Why the secret is a column and not a signing key
--
-- The ingest service has no credential of its own, so the URL this server exposes
-- has to be self-authorising: whoever holds it can read the document. A signed URL
-- would need a key to rotate; a random secret per row needs nothing and can be
-- revoked by deleting the row. It is deliberately a separate column from `id` so
-- that `id` can be shown in a UI or a log without granting access to the bytes.
--
-- ## Why `filename` is stored, and matters more than it looks
--
-- The ingest service routes by FILE EXTENSION: a PDF it cannot see as `.pdf` is
-- treated as a web page and parsed as HTML. So the name is not cosmetic — it is
-- part of the wire contract, and it is preserved verbatim (minus path separators)
-- so the served URL can end in the right extension.

CREATE TABLE documents (
  id            uuid PRIMARY KEY,
  -- Owner. Uploads are per user even though the resulting wiki is shared.
  user_id       text NOT NULL,
  -- Verbatim, path separators removed: the extension is what the service routes on.
  filename      text NOT NULL,
  content_type  text NOT NULL DEFAULT 'application/octet-stream',
  bytes         integer NOT NULL CHECK (bytes >= 0),
  -- The capability half of the URL. Never returned by a listing endpoint.
  secret        text NOT NULL,
  content       bytea NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- A document id is never enumerated by a client; it is always reached through the
-- user's own list first, so the listing query is the one that needs an index.
CREATE INDEX documents_by_user_recent
  ON documents (user_id, created_at DESC);

-- Two documents by the same user with the same name are different resources: the
-- same bytes uploaded twice still gets two ids, so deleting one never silently
-- breaks a job that referenced the other.

-- Which document a job was started for. Nullable because a job may be started from
-- a plain URL or path that never went through an upload, and that case must stay
-- supported: it is the only option when the source already lives somewhere the
-- service can read.
ALTER TABLE agent_runs
  ADD COLUMN document_id uuid REFERENCES documents (id) ON DELETE SET NULL;

-- The ingest jobs live in the other service, not here, so a job id is just a
-- string we remember in order to correlate. No foreign key: the service owns
-- retention (1 h / 200 entries) and we must not be able to break it from here.
CREATE TABLE document_ingests (
  document_id  uuid PRIMARY KEY REFERENCES documents (id) ON DELETE CASCADE,
  user_id      text NOT NULL,
  -- The service's job identity, e.g. `ing_<ULID>`.
  job_id       text,
  -- Last state we SAW. Informational only: the service is the authority, and a
  -- stale row here must never be rendered as a live status.
  last_status  text NOT NULL DEFAULT 'requested',
  requested_at timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX document_ingests_by_job ON document_ingests (job_id)
  WHERE job_id IS NOT NULL;
