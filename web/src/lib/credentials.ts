/**
 * Where identity comes from, and what a link is allowed to say about it.
 *
 * ## Why this is a module and not four lines in `App.tsx`
 *
 * The rule below is the product's whole access model, and it was wrong in a way no
 * one could see: the component demanded BOTH halves of the link and fell back to a
 * sign-in form when one was missing, so a link carrying only a token — which the
 * server happily authenticates — showed a form asking for a token the person did
 * not have.
 *
 * Kept as pure functions over `location.search`, this is testable without a DOM and
 * survives the next redesign of whichever screen happens to render it.
 *
 * ## The contract, measured rather than assumed
 *
 *   curl -H "x-dev-token: $TOK"                 /api/me  -> 200 {"id":"bob"}
 *   curl -H "x-dev-token: $TOK" -H "x-user-id;" /api/me  -> 401
 *
 * Two consequences drive everything here:
 *
 *  - The token alone is a COMPLETE identity. `user` is optional and exists only so
 *    the interface can name the account before `/me` answers.
 *  - A header with an EMPTY value is refused, while an absent header is fine. So
 *    `x-user-id` must be omitted, never sent blank (`server/src/http/users.ts`).
 *
 * `user` is never trusted as identity: the server resolves the id from the token and
 * refuses a claimed id that disagrees with it. A link cannot use this field to act
 * as somebody else.
 */
export interface Credentials {
  /** The secret. This is what identifies the caller. */
  token: string;
  /** Display hint only. `GET /me` is the authority on who this token belongs to. */
  user?: string;
}

/**
 * Read credentials from a query string like `location.search`.
 *
 * Returns `null` when there is no usable token — which is the ONE case where the
 * interface has nothing to work with, because no amount of typing produces a
 * credential that is not already the token.
 *
 * Values are trimmed: a token copied out of a chat window arrives with whitespace
 * often enough that a trailing newline used to read as a wrong token.
 */
export function parseCredentials(search: string): Credentials | null {
  const params = new URLSearchParams(search);
  const token = params.get("token")?.trim();
  if (!token) return null;

  const user = params.get("user")?.trim();
  // `?user=&token=x` must not become `{ user: "" }`: that would send a blank
  // header, which the server refuses.
  return user ? { token, user } : { token };
}

/**
 * The headers a request needs to carry this identity.
 *
 * `x-user-id` is included ONLY when the link named a user, because sending it blank
 * answers `401` while omitting it is the supported path.
 */
export function authHeaders(credentials: Credentials): Record<string, string> {
  const headers: Record<string, string> = { "x-dev-token": credentials.token };
  if (credentials.user) headers["x-user-id"] = credentials.user;
  return headers;
}

/**
 * The query string that reproduces these credentials in a link.
 *
 * Built with `URLSearchParams` so a token containing `&`, `=` or a space survives a
 * round trip instead of silently truncating the identity.
 */
export function credentialsUrl(credentials: Credentials): string {
  const params = new URLSearchParams();
  if (credentials.user) params.set("user", credentials.user);
  params.set("token", credentials.token);
  return `?${params.toString()}`;
}
