/**
 * Types for `provision-mcp.mjs`.
 *
 * The script stays plain JavaScript on purpose: it is run directly with `node` from a
 * checkout, where nothing compiles anything, and operators read it. But its two
 * exported helpers are now imported by a test, and hand-written JavaScript is
 * otherwise invisible to `tsc` — so the shape lives here instead of loosening
 * `allowJs` for the whole server, which would silently widen the type-checked surface
 * for every script in the repository.
 *
 * Keep this in step with the script: it describes the exports a test or the server
 * reads, and a new one would need a line here to be usable.
 */
export function deprecatedDefaultStack(env?: NodeJS.ProcessEnv): string | null;

/**
 * Exactly what provisioning writes into `tenant_mcp.exposed_tools`.
 *
 * A test compares the shipped role's tool names against this, so the comparison is
 * against what is really granted rather than against a copy that could drift.
 */
export const TOOLS: readonly string[];

/**
 * The tools that read one Stack, as this repository already maintains them.
 *
 * Exported here because the request path now reads that same constant instead of
 * keeping a second copy: one definition, and a tool added to provisioning is
 * Stack-scoped for the agent in the same edit.
 */
export const STACK_TOOLS: readonly string[];

export function warnDeprecatedDefaultStack(
  env?: NodeJS.ProcessEnv,
  write?: (line: string) => void,
): string | null;

/**
 * The tool names out of one `tools/list` answer, streamed or plain.
 *
 * Throws rather than returning an empty list: an unreadable or refused answer is not a
 * host that publishes nothing, and the difference decides which side the operator is
 * told to fix.
 */
export function parseToolsList(payload: string | object): {
  tools: string[];
  nextCursor: string | undefined;
};

/**
 * Every tool name the host at `url` publishes, cursors followed.
 *
 * `fetchImpl` exists so a test can drive it without a server; the default is the global
 * `fetch`. Throws when the host cannot be reached, naming `--skip-drift-check`.
 */
export function fetchHostTools(
  url: string,
  options?: {
    fetchImpl?: typeof fetch;
    headers?: Record<string, string>;
    timeoutMs?: number;
  },
): Promise<string[]>;

/**
 * Refuse a grant list the host cannot honour. Throws naming every granted-but-absent
 * tool; returns the counts otherwise, including the tools deliberately left ungranted.
 */
export function checkHostGrants(
  published: readonly string[],
  options?: { url?: string; granted?: readonly string[] },
): { published: number; granted: number; dropped: string[] };
