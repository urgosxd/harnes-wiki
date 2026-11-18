#!/usr/bin/env node
/**
 * Give every roster user access to the external MCP server.
 *
 * ## Why a script and not a migration
 *
 * `tenant_mcp` is per user, and the roster lives in `CHAT_USERS` — environment, not
 * the database. A migration runs once and cannot know who the users will be; a
 * script can be re-run whenever the roster changes, which is exactly how often this
 * data needs to change.
 *
 * ## Why it is idempotent
 *
 * Re-running must fix drift, not duplicate rows. The primary key is
 * `(user_id, server_name)`, so an upsert on that pair means running it twice is the
 * same as running it once — and a corrected URL replaces the old one instead of
 * adding a second server with a stale address.
 *
 * ## What it deliberately does NOT do
 *
 * It does not create users, and it does not invent a URL. A missing `CHAT_USERS` or
 * `MCP_SERVER_URL` is a configuration error that should be named, not defaulted:
 * pointing at the wrong endpoint silently would surface as tools that cannot answer,
 * with no explanation.
 *
 * It also no longer stores a Stack. `MCP_DEFAULT_STACK_ID` was the last piece of
 * deployment-scoped tenant context, and it is deprecated: the Stack now travels with
 * the request that asks for it. A value still set is named once and ignored.
 *
 * Usage (from `server/`, where `pg` is installed):
 *   MCP_SERVER_URL=http://172.17.0.1:4173/mcp \
 *   DATABASE_URL=postgres://... \
 *   node scripts/provision-mcp.mjs
 *
 *   Add --dry-run to see what would change without writing.
 *   Add --skip-drift-check only when the host is unreachable and the list is known current.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Which ids get the tools.
 *
 * Three sources, in order: `USERS` (plain comma-separated names, matching what the
 * scripts and the smoke test use), then `CHAT_USERS` (`id:token,...`, the form a
 * roster deployment still sets), then a legacy `.chat-users` file if one is lying
 * around from an older checkout.
 *
 * Ids here are just rows in `tenant_mcp`. They are not a whitelist: with the default
 * AUTH_MODE=open the server accepts any well-formed name, so a user this script was
 * not run for still opens the product — they simply get no tools until it is.
 */
function loadRoster() {
  const ids = [];
  const add = (id) => {
    const trimmed = id.trim();
    if (trimmed && !ids.includes(trimmed)) ids.push(trimmed);
  };

  const plain = process.env.USERS?.trim();
  if (plain) {
    for (const entry of plain.split(",")) add(entry);
  } else {
    let raw = process.env.CHAT_USERS?.trim();
    if (!raw) {
      try {
        // The file lives at the repository root; this script lives in
        // `server/scripts/`, one level deeper than the root scripts are.
        raw = readFileSync(join(HERE, "..", "..", ".chat-users"), "utf8").trim();
      } catch {
        throw new Error(
          "No users. Set USERS=alice,bob (or CHAT_USERS=id:token,...) first.",
        );
      }
    }
    for (const entry of raw.split(",")) {
      const separator = entry.indexOf(":");
      add(separator === -1 ? entry : entry.slice(0, separator));
    }
  }

  if (ids.length === 0) throw new Error("No users were declared.");
  return ids;
}

/**
 * The tools the agent may call.
 *
 * ## Why this is a list and not "everything the service exposes"
 *
 * The service offers fifteen. Granting all of them would hand the model operations
 * this project never decided to allow — compiling, ingesting, running evals, writing
 * bundle files. A tool grant is a decision, and the default has to be that someone
 * made it.
 *
 * ## Why the earlier rationale was wrong
 *
 * This list used to carry three tools under the comment "the other twelve are
 * filesystem-scoped". Checked against the live schema and that was simply false:
 * most of the twelve are READ-ONLY queries over the compiled wiki, which is precisely
 * the capability a user asking "what does my knowledge base say" expects. Refusing
 * them left the assistant unable to answer the question it existed to answer.
 *
 * ## The split that replaced it
 *
 * Reading the wiki is allowed. Changing it is not. That is a rule someone can audit,
 * unlike "which of these look filesystem-y".
 *
 * ## The second rule: the shipped role's tools are not optional
 *
 * `server/agents/wiki-agentic-search.md` is a shipped role, and its body tells the
 * model which tools to call. A grant list that omits one of them does not produce a
 * degraded answer — it produces a role that asks for tools it does not have, which is
 * the "fails in prod" case. So every tool the role names is granted here, and
 * `test/provision-mcp.test.ts` pins the agreement in both directions: role tools
 * must be covered, and no mutating tool may be granted.
 *
 * `read_page` was previously absent on the strength of a live observation that the
 * slugs `search_pages` returned were rejected by it with "Page not found", with and
 * without an explicit `stackId`. That finding is not withdrawn — a shipped role that
 * reads pages needs the tool, and whether the host's page ids resolve is a host
 * defect to fix there, not a reason to ship a role whose own instructions cannot run.
 * It needs a live host to re-check.
 *
 * `query_stack` is the graph dimension's read query. It is filed with the Stack tools
 * rather than the wiki reads for a measured reason: it takes a `stackId` on every call
 * and reads ONE Stack (`server/agents/wiki-agentic-search.md`), exactly like
 * `list_stacks`, and `STACK_TOOLS` is the by-name list `src/pi/tenant-runtime.ts:501`
 * uses to decide a tool is Stack-scoped even before its schema is read. Leaving it out
 * would let a call that names no Stack through the scope gate on a schema the host
 * might not publish.
 *
 * Every name in this list is bare (`read_page`, not `mcp__…__read_page`) because that
 * is what the column holds: `exposed_tools` is a flat allowlist of bare tool names,
 * intersected with each connected server's own `listTools()` names
 * (`src/pi/tenant-runtime.ts:201`), so a prefixed spelling here would match nothing and
 * quietly grant no capability at all.
 */
export const READ_ONLY_WIKI_TOOLS = [
  "query_wiki",
  "search_pages",
  "read_page",
  "get_context_pack",
  "wiki_status",
  "lint_wiki",
  // `verify_artifact` was granted here until the host stopped publishing it: the
  // 2026-11-18 build lists 17 tools and none of them is that one. A grant for a tool the
  // host does not expose is silently dropped by the intersection below, so it reads as
  // "granted" in the database and grants nothing — the one state this list exists to keep
  // out.
];

export const STACK_TOOLS = [
  "list_stacks",
  // The graph dimension's three reads. They are filed here rather than with the wiki
  // reads for the same measured reason `query_stack` always was: each takes a `stackId`
  // on every call and reads exactly one Stack, and this by-name list is what
  // `src/pi/tenant-runtime.ts` consults to decide a tool is Stack-scoped before its
  // schema is read.
  "query_stack",
  "traverse_stack",
  "get_entities",
  "ingest_jobs_list",
  "ingest_job_status",
];

export const TOOLS = [...STACK_TOOLS, ...READ_ONLY_WIKI_TOOLS];

/**
 * Headers the endpoint requires on every request.
 *
 * Streamable HTTP answers 406 without the event-stream half of `Accept`, so this is
 * not optional decoration.
 */
export const HEADERS = { accept: "application/json, text/event-stream" };

/**
 * How long the drift check waits for the host before giving up.
 *
 * Short on purpose: this is a single `tools/list` round trip to a host on the same
 * network, and a provisioning run that hangs for minutes on an unresponsive endpoint is
 * worse than one that says it could not verify.
 */
export const TOOLS_LIST_TIMEOUT_MS = 10_000;

/**
 * The tool names out of one `tools/list` answer.
 *
 * ## Why this parses SSE by hand
 *
 * Streamable HTTP answers MCP over `text/event-stream`: the JSON-RPC body arrives after
 * `data:` on its own line, sometimes after an `event: message` line, sometimes as plain
 * JSON when the client did not ask for the stream. Both happen against the same server
 * depending on the `Accept` header, so the parser accepts both rather than betting on
 * one — and `HEADERS` above is what forces the stream, so the SSE branch is the one this
 * script actually takes.
 *
 * An `error` member is raised, not swallowed: a `tools/list` that answers with an error
 * object is a host refusing, and reporting "zero tools published" for it would produce
 * exactly the wrong diagnosis.
 */
export function parseToolsList(payload) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  const candidates = [];
  if (/^(event|data):/m.test(text)) {
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("data:")) candidates.push(line.slice("data:".length).trim());
    }
  } else {
    candidates.push(text.trim());
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    let message;
    try {
      message = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (message?.error) {
      throw new Error(
        `tools/list answered with an error: ${message.error.message ?? JSON.stringify(message.error)}`,
      );
    }
    const tools = message?.result?.tools;
    if (Array.isArray(tools)) {
      return {
        tools: tools.map((tool) => tool?.name).filter((name) => typeof name === "string"),
        nextCursor:
          typeof message.result.nextCursor === "string" ? message.result.nextCursor : undefined,
      };
    }
  }

  throw new Error("tools/list answered without a result.tools array");
}

/**
 * Every tool name the host publishes right now.
 *
 * This is the measurement the grant list has to be compared against. It exists because
 * the alternative — trusting a list written months ago in a different repository — failed
 * in production: the copy of this script baked into an older server image still granted
 * `verify_artifact`, wrote eleven names, and the runtime's intersection dropped one of
 * them without a word. The rows said "granted", the model had nothing.
 *
 * Cursors are followed because `tools/list` is paginated in the protocol, and a
 * first-page-only read would report a truncated host as if it were the whole one. The
 * bound is ten pages: a host that needs more than that is not something this script can
 * verify honestly, and silently reading a fraction of it is the failure this whole
 * function is here to prevent.
 */
export async function fetchHostTools(url, options = {}) {
  const {
    fetchImpl = fetch,
    headers = HEADERS,
    timeoutMs = TOOLS_LIST_TIMEOUT_MS,
  } = options;

  const names = [];
  let cursor;
  for (let page = 0; page < 10; page += 1) {
    const request = { jsonrpc: "2.0", id: page + 1, method: "tools/list" };
    if (cursor !== undefined) request.params = { cursor };

    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(
        `could not reach ${url} to verify the grant list: ${error instanceof Error ? error.message : String(error)}. ` +
          "Pass --skip-drift-check only if you know the list is current.",
      );
    }

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`tools/list at ${url} answered HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    const parsed = parseToolsList(body);
    names.push(...parsed.tools);
    cursor = parsed.nextCursor;
    if (cursor === undefined) break;
  }

  return [...new Set(names)];
}

/**
 * Refuse a grant list the host cannot honour, and report the rest.
 *
 * ## Why this fails instead of warning
 *
 * `exposed_tools` is intersected with each connected server's own tool names
 * (`src/pi/tenant-runtime.ts`). A granted name the host does not publish is therefore not
 * a degraded capability — it is a row that claims a capability and grants nothing, and
 * the operator sees a green "provisioned 11 tool(s)". The only honest state is: nothing
 * was written, and here is what does not exist.
 *
 * ## Why the tools left ungranted are reported separately
 *
 * Dropping `ingest_source` or `compile_wiki` is a DECISION, not drift: the allowlist
 * exists to leave writes out. Only the granted-but-absent direction is an error, so the
 * other direction is printed as a count and a name list, for audit — never as a failure.
 *
 * ## The two causes, both named in the message
 *
 * A stale grant list is almost always a stale SCRIPT: `server/Dockerfile` ships
 * `scripts/` into the image, so an image built before the list changed keeps pointing at
 * the old one. Running that baked copy is what this check catches. The other cause is a
 * host that changed under the list, which needs re-measuring, not retrying.
 */
export function checkHostGrants(published, options = {}) {
  const { url = process.env.MCP_SERVER_URL, granted = TOOLS } = options;
  const available = new Set(published);
  const missing = granted.filter((name) => !available.has(name)).sort();

  if (missing.length > 0) {
    throw new Error(
      `the MCP server at ${url ?? "(unknown url)"} does not publish ${missing.join(", ")}. ` +
        "A grant for a tool the host does not expose is dropped silently when the tools are " +
        "intersected, so writing it would record a capability nothing grants. Nothing was " +
        "written. Either this grant list is stale — the copy baked into an older server image " +
        "is the usual cause, so run provision-mcp.mjs from the checkout — or the host changed " +
        "and TOOLS needs re-measuring against its tools/list.",
    );
  }

  return {
    published: available.size,
    granted: granted.length,
    dropped: [...available].filter((name) => !granted.includes(name)).sort(),
  };
}


/**
 * The Stack every MCP call used to name.
 *
 * ## DEPRECATED, and now ignored
 *
 * This used to be REQUIRED, and leaving it unset made every agent call inherit
 * whatever Stack the remote host happened to be bound to (2026-10-28: that binding
 * moved to an empty Stack, and the agent truthfully reported 0 pages about a Stack
 * the user had never heard of). Storing the Stack here was the fix at the time.
 *
 * The Stack is no longer deployment context. It travels with the REQUEST: the page
 * forwards the `stackId` from its link, the turn route opens a context for that
 * request, and the MCP proxy reads it per call — failing closed when the request
 * names none. So this variable is neither read into the database nor consulted at
 * call time, and nothing here writes it.
 *
 * Kept as a parser only, so a value someone still has set can be NAMED in a warning
 * instead of silently ignored: an operator who believes a variable still scopes their
 * reads is worse off than one who is told it does not.
 */
export function deprecatedDefaultStack(env = process.env) {
  const value = (env.MCP_DEFAULT_STACK_ID ?? "").trim();
  return value ? value : null;
}

/**
 * Say once that the variable no longer does anything. Never fails.
 *
 * Absence is silent and provisions normally: refusing to provision because a
 * deprecated variable is missing would break every deployment that already stopped
 * setting it. Presence is tolerated and reported, which is also why an existing
 * stored value needs no cleanup — it is left where it is and never consulted.
 */
export function warnDeprecatedDefaultStack(
  env = process.env,
  write = (line) => process.stderr.write(line),
) {
  const ignored = deprecatedDefaultStack(env);
  if (!ignored) return null;
  write(
    "provision-mcp: MCP_DEFAULT_STACK_ID is deprecated and ignored. " +
      "The Stack now comes from the request link (x-stack-id), so no default is " +
      "stored or used. Remove the variable when convenient.\n",
  );
  return ignored;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const skipDriftCheck = process.argv.includes("--skip-drift-check");
  const url = process.env.MCP_SERVER_URL?.trim();
  if (!url) {
    throw new Error(
      "MCP_SERVER_URL is required, e.g. http://172.17.0.1:4173/mcp — the endpoint that serves the Stack tools.",
    );
  }
  if (!/^https?:\/\//.test(url)) {
    throw new Error(`MCP_SERVER_URL must be an http(s) URL, got "${url}"`);
  }
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");

  const users = loadRoster();
  // One deprecation line per run, before any row is touched, and never an error.
  warnDeprecatedDefaultStack();

  // Measure the host BEFORE connecting to the database: a stale list must not overwrite
  // rows that are currently correct, and `--dry-run` should refuse the same way a write
  // would. The check is skipped only on request, and never silently.
  let drift = null;
  if (skipDriftCheck) {
    process.stderr.write(
      "provision-mcp: --skip-drift-check: the grant list is NOT being verified against the host.\n",
    );
  } else {
    drift = checkHostGrants(await fetchHostTools(url), { url });
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    for (const userId of users) {
      if (dryRun) {
        process.stdout.write(`would provision ${userId} -> ${url}\n`);
        continue;
      }
      // Upsert on the natural key: running twice is the same as running once, and a
      // corrected address REPLACES the old row rather than adding a second server.
      //
      // `default_stack_id` is deliberately absent from both halves: not written on
      // insert, not touched on conflict. A value provisioned before the deprecation
      // stays exactly as it is and is never read, so re-running this script can
      // neither resurrect nor destroy it.
      await client.query(
        `INSERT INTO tenant_mcp
           (user_id, server_name, command, transport, url, headers, exposed_tools,
            enabled)
         VALUES ($1, 'wiki', '', 'http', $2, $3::jsonb, $4::jsonb, true)
         ON CONFLICT (user_id, server_name) DO UPDATE
           SET transport = 'http',
               command = '',
               url = excluded.url,
               headers = excluded.headers,
               exposed_tools = excluded.exposed_tools,
               enabled = true`,
        [userId, url, JSON.stringify(HEADERS), JSON.stringify(TOOLS)],
      );
      process.stdout.write(`provisioned ${userId} -> ${url}\n`);
    }
    process.stdout.write(
      `\n${users.length} user(s) ${dryRun ? "would be" : ""} provisioned with ${TOOLS.length} tool(s).\n`,
    );
    if (drift) {
      // The count alone was the misleading part of the old output: "11 tool(s)" looked
      // like eleven capabilities when one of them did not exist. Say what was measured.
      const dropped = drift.dropped.length
        ? ` ${drift.dropped.length} left ungranted (${drift.dropped.join(", ")}).`
        : " Nothing left ungranted.";
      process.stdout.write(
        `Host publishes ${drift.published}; all ${drift.granted} granted tool(s) exist.${dropped}\n`,
      );
    }
  } finally {
    await client.end();
  }
}

// Importing this module must not provision anything: the tests import the warning
// parser above, and a script that runs on import cannot be tested at all.
const invokedPath = process.argv[1] ?? "";
if (invokedPath.endsWith("provision-mcp.mjs")) {
  main().catch((error) => {
    process.stderr.write(`provision-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
