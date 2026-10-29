-- Which Stack the agent reads from when it does not name one.
--
-- The MCP read tools all take an OPTIONAL `stackId`, and omitting it means "use the
-- host's binding". That was fine while the host happened to be bound to the Stack
-- holding the user's work. It stopped being fine on 2026-10-28 when the binding moved
-- to an empty Stack: `wiki_status` answered "0 pages" and `query_wiki` answered "No
-- compiled pages found", both truthfully, about a Stack the user had never heard of.
--
-- So this product stops inheriting the host's default. It stores the Stack to name on
-- every call. NULL means "not configured", and the agent then passes nothing rather
-- than passing a guess.
--
-- Not a foreign key to anything here: the Stack lives in the other service's database,
-- and a constraint across two systems is a lie about their independence.
ALTER TABLE tenant_mcp
  ADD COLUMN IF NOT EXISTS default_stack_id text;

COMMENT ON COLUMN tenant_mcp.default_stack_id IS
  'Stack the agent names on every MCP call. NULL means the host default is used, which this product does not recommend.';
