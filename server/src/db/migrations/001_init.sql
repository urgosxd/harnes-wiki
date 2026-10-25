-- Conversation catalog and transcript.
--
-- session_entries is the single source of truth for a conversation's history.
-- Pi session files are NOT used: the SDK keeps entries flat during a turn and
-- writes its session file only after the first assistant message, so a crash
-- mid-turn loses the turn entirely. The transcript lives here instead, and a Pi
-- session is rebuilt from these rows for every turn.

CREATE TABLE conversations (
  id            uuid PRIMARY KEY,
  user_id       text NOT NULL,
  title         text,
  -- The Pi session id, so entries rebuilt from here line up with what Pi expects.
  pi_session_id uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz
);

-- The sidebar query: one user's conversations, most recent first.
CREATE INDEX conversations_by_user_recent
  ON conversations (user_id, updated_at DESC)
  WHERE archived_at IS NULL;

CREATE TABLE session_entries (
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  -- Monotonic position. Rebuilding a session depends on replaying in this order.
  seq             bigint NOT NULL,
  -- A Pi SessionEntry, verbatim. Not interpreted here.
  entry           jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, seq)
);

-- A turn is one user message plus whatever the agent produced. The idempotency
-- key is what makes a reconnect safe: the same key never starts a second run, and
-- Pi cannot replay a request for us.
CREATE TABLE agent_runs (
  id               uuid PRIMARY KEY,
  conversation_id  uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  idempotency_key  text NOT NULL,
  status           text NOT NULL
    CHECK (status IN ('running', 'ok', 'error', 'aborted', 'length')),
  -- The persisted assistant message's stopReason, when the run produced one.
  stop_reason      text,
  error_message    text,
  input_tokens     integer,
  output_tokens    integer,
  total_tokens     integer,
  cost_total       numeric(18, 12),
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz
);

-- The idempotency guarantee itself, enforced by the database rather than by
-- server code that could race with a second instance.
CREATE UNIQUE INDEX agent_runs_idempotency
  ON agent_runs (conversation_id, idempotency_key);

CREATE INDEX agent_runs_by_conversation
  ON agent_runs (conversation_id, started_at DESC);

-- Which MCP servers a user is allowed to reach. The server injects this
-- configuration in-process; nothing is read from a per-user mcp.json, because
-- that path is blocked by project trust in SDK mode.
CREATE TABLE tenant_mcp (
  user_id      text NOT NULL,
  server_name  text NOT NULL,
  command      text NOT NULL,
  args         jsonb NOT NULL DEFAULT '[]'::jsonb,
  env          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- MCP tool names exposed to the model for this server.
  exposed_tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, server_name)
);

-- Business permissions, enforced inside each tool's execute.
CREATE TABLE tenant_scopes (
  user_id  text NOT NULL,
  scope    text NOT NULL,
  PRIMARY KEY (user_id, scope)
);

-- Makes "append-only" a property the database enforces, not a convention the
-- application is trusted to follow. A transcript that can be silently rewritten
-- is not a transcript.
--
-- DELETE is the subtle case. Two very different things reach this trigger:
--   1. A direct DELETE, which would erase a conversation's history while the
--      conversation itself still exists. That is a rewrite and must be refused.
--   2. The ON DELETE CASCADE from removing a conversation, which is the only way
--      a user can actually delete their data. Refusing it would make deletion
--      impossible.
-- They are distinguished by whether the parent row still exists. PostgreSQL runs
-- the referential-integrity action after the parent row is gone, so a cascade
-- arrives here with the parent already missing. That ordering is verified by
-- test/conversation-store.test.ts rather than assumed: if it ever changes, the
-- cascade test fails instead of silently blocking user deletion.
CREATE OR REPLACE FUNCTION session_entries_no_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM conversations WHERE id = OLD.conversation_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'session_entries is append-only: % is not allowed', TG_OP;
END;
$$;

CREATE TRIGGER session_entries_append_only
  BEFORE UPDATE OR DELETE ON session_entries
  FOR EACH ROW EXECUTE FUNCTION session_entries_no_update();

CREATE OR REPLACE FUNCTION conversations_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER conversations_touch
  BEFORE UPDATE OF title, archived_at ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_touch_updated_at();
