-- Let a tenant's MCP server be reached over HTTP as well as stdio.
--
-- ## Why the shape of the seam had to change
--
-- `tenant_mcp` assumed stdio: it carried a `command` and `args`, and the runtime
-- built a `StdioTransport` unconditionally. That is fine for a server this
-- container can spawn — an in-image binary, a `npx` package — but it makes an
-- EXTERNAL service unreachable without shipping its binary here, which is exactly
-- the coupling this project refuses.
--
-- An MCP server reachable over streamable HTTP removes that: the client speaks the
-- protocol to a URL, and nothing of the other side enters this image. The seam
-- then needs to say WHICH transport a row describes, because "command" and "url"
-- are not interchangeable and guessing from an empty field is how a misconfigured
-- row turns into a confusing runtime error.
--
-- ## Defaults
--
-- `transport` defaults to 'stdio' so every row written before this migration keeps
-- working unchanged, and a row that says 'http' must carry a url — enforced by the
-- check constraint rather than by trusting callers, because a half-filled row is a
-- configuration error that should surface at write time.

ALTER TABLE tenant_mcp
  ADD COLUMN transport text NOT NULL DEFAULT 'stdio'
    CHECK (transport IN ('stdio', 'http'));

-- Null for stdio rows. A URL is required for http rows (see the constraint below).
ALTER TABLE tenant_mcp
  ADD COLUMN url text;

-- An http row with no url cannot be connected, and a stdio row with no command
-- cannot be spawned. Refusing both at the database means no runtime path has to
-- decide what a half-populated row means.
ALTER TABLE tenant_mcp
  ADD CONSTRAINT tenant_mcp_transport_target
    CHECK (
      (transport = 'stdio' AND length(trim(command)) > 0)
      OR (transport = 'http' AND url IS NOT NULL AND length(trim(url)) > 0)
    );

-- Headers an http MCP server may require on every request.
--
-- Some servers gate on `Accept` or an `Authorization` header before they will
-- answer, so the row has to carry them: injecting them from code would put one
-- deployment's requirement into every deployment's build.
ALTER TABLE tenant_mcp
  ADD COLUMN headers jsonb NOT NULL DEFAULT '{}'::jsonb;
