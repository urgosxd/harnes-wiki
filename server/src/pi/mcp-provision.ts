import type { Database, TransactionClient } from "../db/pool.ts";
import { MCP_ALL_TOOLS, MCP_HEADERS, MCP_READ_TOOLS } from "./mcp-tools.ts";

/**
 * Automatic tenant MCP provisioning.
 *
 * `tenant_mcp` is keyed per user and has no foreign key to `users`, so creating an
 * account used to leave it with no tools until an operator remembered to run
 * `scripts/provision-mcp.mjs`. That is the failure this module removes: the server
 * upserts the row for every account at boot and for every account `POST /api/users`
 * creates, so a new user's first turn already has the tools the role names.
 *
 * The server name stays `wiki` because that is the row the deployment has always used.
 * The URL and the options come from the environment; with no `MCP_SERVER_URL` the
 * feature is off, which keeps the development stack and the legacy suites unchanged.
 */

export interface McpProvisioning {
  /** The Streamable HTTP endpoint, e.g. `http://host:4173/mcp`. */
  url: string;
  headers: Record<string, string>;
  tools: string[];
}

/** Values that mean "yes" for a boolean environment variable, matching the rest of the service. */
function truthy(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/**
 * Read the provisioning settings, or `undefined` when the deployment has no MCP server.
 *
 * A malformed URL is a boot failure, not a silent skip: an operator who set the variable
 * expects tools, and a server that starts without them reproduces exactly the invisible
 * failure this module exists to fix.
 */
export function resolveMcpProvisioning(
  env: NodeJS.ProcessEnv = process.env,
): McpProvisioning | undefined {
  const raw = env.MCP_SERVER_URL?.trim();
  if (!raw) return undefined;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`MCP_SERVER_URL must be an absolute URL, got "${raw}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`MCP_SERVER_URL must be http or https, got "${url.protocol}"`);
  }
  if (url.hostname === "0.0.0.0") {
    throw new Error(
      "MCP_SERVER_URL must be a reachable address, not 0.0.0.0: that is a bind address.",
    );
  }

  return {
    url: raw,
    headers: { ...MCP_HEADERS },
    // Writes stay opt-in. The role is read-only, and a grant is a product decision.
    tools: [...(truthy(env.MCP_GRANT_ALL_TOOLS) ? MCP_ALL_TOOLS : MCP_READ_TOOLS)],
  };
}

type Queryable = Pick<Database, "query"> | TransactionClient;

/**
 * Write (or repair) one user's row.
 *
 * Upsert on `(user_id, server_name)` so running it twice is the same as running it
 * once, and a corrected URL or grant list replaces the old value. `default_stack_id`
 * is deliberately untouched: it is deprecated and never read.
 */
export async function upsertTenantMcp(
  client: Queryable,
  userId: string,
  provisioning: McpProvisioning,
): Promise<void> {
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
    [
      userId,
      provisioning.url,
      JSON.stringify(provisioning.headers),
      JSON.stringify(provisioning.tools),
    ],
  );
}

/**
 * Give every existing account the row, and say which ids were touched.
 *
 * Called after migrations and seeding, before the first turn. A user created later goes
 * through `POST /api/users`, which does the same upsert inside its transaction.
 */
export async function provisionAllUsers(
  db: Database,
  provisioning: McpProvisioning,
): Promise<string[]> {
  const accounts = await db.query<{ id: string }>("SELECT id FROM users ORDER BY id");
  for (const account of accounts) {
    await upsertTenantMcp(db, account.id, provisioning);
  }
  return accounts.map((account) => account.id);
}
