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
 * pointing at the wrong endpoint silently would surface as an empty stack picker
 * with no explanation.
 *
 * Usage (from `server/`, where `pg` is installed):
 *   MCP_SERVER_URL=http://172.17.0.1:4173/mcp \
 *   DATABASE_URL=postgres://... \
 *   node scripts/provision-mcp.mjs
 *
 *   Add --dry-run to see what would change without writing.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Roster from `CHAT_USERS`, or from the local `.chat-users` file the other scripts
 * generate. Same two sources `up.sh` and the smoke test use, so the ids here are the
 * ids the server actually authenticates.
 */
function loadRoster() {
  let raw = process.env.CHAT_USERS?.trim();
  if (!raw) {
    try {
      // The roster file lives at the repository root; this script lives in
      // `server/scripts/`, one level deeper than the root scripts are.
      raw = readFileSync(join(HERE, "..", "..", ".chat-users"), "utf8").trim();
    } catch {
      throw new Error(
        "No roster. Set CHAT_USERS=id:token,id:token or run scripts/up.sh first.",
      );
    }
  }
  const ids = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(":");
    if (separator === -1) continue;
    const id = trimmed.slice(0, separator).trim();
    if (id) ids.push(id);
  }
  if (ids.length === 0) throw new Error("The roster declared no users.");
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
 * `read_page` is deliberately absent: verified live that the slugs `search_pages`
 * returns are rejected by it with "Page not found", with and without an explicit
 * `stackId`. Granting a tool that cannot succeed would teach the model that its own
 * capabilities are unreliable.
 */
export const READ_ONLY_WIKI_TOOLS = [
  "query_wiki",
  "search_pages",
  "wiki_status",
  "lint_wiki",
  "get_context_pack",
  "verify_artifact",
];

export const STACK_TOOLS = ["list_stacks", "ingest_jobs_list", "ingest_job_status"];

export const TOOLS = [...STACK_TOOLS, ...READ_ONLY_WIKI_TOOLS];

/**
 * Headers the endpoint requires on every request.
 *
 * Streamable HTTP answers 406 without the event-stream half of `Accept`, so this is
 * not optional decoration.
 */
export const HEADERS = { accept: "application/json, text/event-stream" };

async function main() {
  const dryRun = process.argv.includes("--dry-run");
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
      await client.query(
        `INSERT INTO tenant_mcp
           (user_id, server_name, command, transport, url, headers, exposed_tools, enabled)
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
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`provision-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
