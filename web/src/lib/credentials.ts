/**
 * Where identity comes from, and what a link is allowed to say about it.
 *
 * ## The decision this file encodes
 *
 * Identity is the `user` in the link. Full stop. There is no password, no session
 * and no per-user secret: opening `?user=alice` opens alice's account.
 *
 * That is not authentication and it cannot pretend to be. Nothing in this file
 * verifies the name against anything, because there is nothing to verify it against
 * — so the honest reading is that **anybody holding a link can act as that user, and
 * anybody can edit the link to act as somebody else.** The server enforces ownership
 * of rows by `user_id`; it cannot enforce who is allowed to claim that `user_id`.
 *
 * ## Why a token is still forwarded
 *
 * `token` is optional and becomes an `x-dev-token` header when present. It costs one
 * line and it keeps two things working that would otherwise break: a link handed out
 * before this change, and a deployment running with `AUTH_MODE=roster`, where the
 * token is what actually identifies the caller. With no token the server uses the
 * name alone.
 *
 * ## Why this is a module and not four lines in `App.tsx`
 *
 * It is the product's whole access model, and it is pure logic over
 * `location.search`: testable without a DOM, and independent of whichever screen
 * happens to render it.
 */
export interface Credentials {
  /** The identity. A claim, not a verified fact. */
  user: string;
  /** Optional. Forwarded when present, never required. */
  token?: string;
}

/**
 * Read credentials from a query string like `location.search`.
 *
 * Returns `null` only when the link names no user. A token with no user used to be
 * enough, when the server could resolve a token against a roster; with no roster a
 * token names nobody, so accepting one would mean guessing which account was meant.
 *
 * Values are trimmed: a name copied out of a chat window arrives with whitespace
 * often enough that `?user=alice%0A` would otherwise be a different user row.
 */
export function parseCredentials(search: string): Credentials | null {
  const params = new URLSearchParams(search);

  const user = params.get("user")?.trim();
  if (!user) return null;

  const token = params.get("token")?.trim();
  // A blank token must not become `token: ""`: that would send an empty header, and
  // an empty `x-dev-token` is a worse signal than no header at all.
  return token ? { user, token } : { user };
}

/**
 * The headers a request needs to carry this identity.
 *
 * `x-user-id` is always sent — it is the identity. `x-dev-token` only travels when
 * the link carried one.
 */
export function authHeaders(credentials: Credentials): Record<string, string> {
  const headers: Record<string, string> = { "x-user-id": credentials.user };
  if (credentials.token) headers["x-dev-token"] = credentials.token;
  return headers;
}

/**
 * The query string that reproduces these credentials in a link.
 *
 * Built with `URLSearchParams` so a value containing `&`, `=` or a space survives a
 * round trip instead of silently truncating the identity.
 */
export function credentialsUrl(credentials: Credentials): string {
  const params = new URLSearchParams();
  params.set("user", credentials.user);
  if (credentials.token) params.set("token", credentials.token);
  return `?${params.toString()}`;
}
