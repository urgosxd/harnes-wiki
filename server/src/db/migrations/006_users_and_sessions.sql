-- Username/password accounts and their sessions.
--
-- user_id stays text to match every existing owner column (conversations,
-- tenant_mcp, tenant_scopes). Those rows are keyed before an account exists and
-- this migration does not rewrite them, so no foreign key is declared on them.
-- Sessions store only the SHA-256 of the token: the cookie value is not a secret
-- the database should be able to replay.

CREATE TABLE users (
  id            text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9._@-]{1,64}$'),
  display_name  text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX sessions_by_user ON sessions (user_id);
CREATE INDEX sessions_by_expiry ON sessions (expires_at);
