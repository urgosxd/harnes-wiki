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
