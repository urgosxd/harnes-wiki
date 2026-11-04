/**
 * Where the tenant comes from, and what a link is allowed to say about it.
 *
 * ## The decision this file encodes
 *
 * The Stack an ingest belongs to is the `stackId` in the link. Full stop. There is
 * no env var, no build-time config, no localStorage, no header, no cookie and no
 * remembered previous value: opening `?user=alice&stackId=<id>` is what scopes a
 * session to a tenant, and a reload without the parameter is blocked exactly like a
 * first visit would be.
 *
 * That is deliberate rather than convenient. A remembered or defaulted Stack would
 * silently attach one tenant's reads to another's, and a cross-tenant read is not a
 * bug you notice — it looks like an empty list, or worse, a full one.
 *
 * ## Why this is a shape check and nothing more
 *
 * Whether the id is a real Stack is the service's answer to give: the server
 * forwards `400 invalid_stack_id`, `404 stack_not_found` and `unknown_stack`
 * unchanged, and the UI surfaces them. Validating a UUID here would add a second,
 * stricter authority that refuses values the service accepts, and would hide the
 * answer the user actually needs.
 *
 * ## Why this is a module and not four lines in `App.tsx`
 *
 * It is pure logic over `location.search`, like `credentials.ts` next door: testable
 * without a DOM, and independent of whichever screen happens to render it.
 */

/**
 * The result of reading `stackId` out of a link.
 *
 * `problem` is a word, not a sentence: the copy belongs to the surface that shows
 * it, so the same rule can be stated where the user is standing.
 */
export type StackIdResolution =
  | { ok: true; stackId: string }
  | { ok: false; problem: "missing" };

/**
 * Read the tenant Stack from a query string like `location.search`.
 *
 * Absent, empty and whitespace-only are the same fact — no tenant — and all three
 * are reported as `missing`, because a value of spaces would otherwise travel to the
 * service as a Stack id that is not one.
 *
 * Values are trimmed: an id copied out of a chat window arrives with whitespace
 * often enough that `?stackId=<id>%0A` would otherwise be a different Stack.
 */
export function parseStackId(search: string): StackIdResolution {
  const stackId = new URLSearchParams(search).get("stackId")?.trim();
  return stackId ? { ok: true, stackId } : { ok: false, problem: "missing" };
}
