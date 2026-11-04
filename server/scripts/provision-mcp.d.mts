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
 * Keep this in step with the script: it describes exactly two exports, and a third
 * would need a line here to be usable from a test.
 */
export function deprecatedDefaultStack(env?: NodeJS.ProcessEnv): string | null;

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
