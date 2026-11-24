/**
 * The one list of MCP tool names this product knows about.
 *
 * It lives in `src/` because TWO callers need it now: the provisioning CLI
 * (`scripts/provision-mcp.mjs`) and the server itself, which provisions every account
 * automatically. Keeping the list in the script only is what made a freshly created user
 * start with no tools: `POST /api/users` wrote a `users` row, and nothing wrote the
 * matching `tenant_mcp` row.
 *
 * Bare names, never `mcp__<server>__<tool>`: `tenant_mcp.exposed_tools` is intersected
 * with each connected server's own `listTools()` names, so a prefixed spelling matches
 * nothing and silently grants no capability.
 */

/** Reads over one Stack, plus the graph dimension. */
export const MCP_STACK_TOOLS = [
  "list_stacks",
  "query_stack",
  "traverse_stack",
  "get_entities",
  "ingest_jobs_list",
  "ingest_job_status",
] as const;

/** Reads over the compiled wiki. */
export const MCP_READ_ONLY_WIKI_TOOLS = [
  "query_wiki",
  "search_pages",
  "read_page",
  "get_context_pack",
  "wiki_status",
  "lint_wiki",
] as const;

/** The default grant: everything the shipped role needs, and nothing that writes. */
export const MCP_READ_TOOLS = [
  ...MCP_STACK_TOOLS,
  ...MCP_READ_ONLY_WIKI_TOOLS,
] as const;

/**
 * Tools that change the wiki or run work on it.
 *
 * Optional, and off unless the deployment asks for them. A deployment that needs the
 * agent to ingest, compile, export or evaluate sets `MCP_GRANT_ALL_TOOLS=true`; the
 * names are still spelled out here instead of inferred from the host, so a new host tool
 * cannot become a capability without someone adding it.
 */
export const MCP_WRITE_TOOLS = [
  "ingest_source",
  "compile_wiki",
  "export_okf",
  "run_eval",
  "ingest_job_delete",
] as const;

/** Every tool the host publishes today, writes included. */
export const MCP_ALL_TOOLS = [...MCP_READ_TOOLS, ...MCP_WRITE_TOOLS] as const;

/**
 * Headers the endpoint requires on every request.
 *
 * Streamable HTTP answers 406 without the event-stream half of `Accept`.
 */
export const MCP_HEADERS = { accept: "application/json, text/event-stream" } as const;
