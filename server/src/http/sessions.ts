import { createHash, randomBytes } from "node:crypto";
import type { Database } from "../db/pool.ts";

/**
 * Sessions: the only thing a password login leaves behind, and the only thing that
 * identifies a caller under `AUTH_MODE=password`.
 *
 * ## Why the cookie is an opaque token and not a signed claim
 *
 * A signed claim (`user=alice` plus a signature) needs a key, and every reader of that
 * key can mint new identities. An opaque token has no user in it at all: there is
 * nothing to edit, so "become somebody else" is not a value transformation but an
 * attempt to guess 32 random bytes. What the token means lives in the database, where
 * it can be deleted — which is how logout actually works.
 *
 * ## Why only the hash is stored
 *
 * The cookie value is a bearer secret. A database that holds it can be replayed against
 * the server by anyone who can read the table, so the table holds `sha256(token)`
 * instead. The plain token travels to the browser and is never written down here.
 *
 * ## Where identity still comes from
 *
 * Nowhere else. No mode falls back to a header: a request under password mode with no
 * cookie is anonymous, whatever `x-user-id` claims.
 */

/** Name of the cookie. Short, and not a name a product would want to use for anything else. */
export const SESSION_COOKIE = "sid";

/** How long a session lives: 30 days, in milliseconds. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Failures of one account that lock it, inside one window. */
export const LOGIN_MAX_FAILURES = 10;

/** Length of the fixed window the failures are counted in: 15 minutes. */
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const TOKEN_BYTES = 32;

/** `sha256` of the token, hex. The only form of it this server ever stores or looks up. */
function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Read a `Cookie` header into name/value pairs.
 *
 * Deliberately forgiving, because this parses a value the CLIENT chose: a pair without
 * `=` (a stray `;`), a pair with an empty name (`=no-name`) and a value cut in half by a
 * proxy must not turn into an exception on a login route. Quoted values are unquoted,
 * which is how a browser sends a value that needed quoting.
 *
 * The last duplicate wins: a browser appends the most specific cookie last, and this is
 * also the rule that keeps the parse deterministic when a client sends junk.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;

  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;

    const name = pair.slice(0, separator).trim();
    if (!name) continue;

    let value = pair.slice(separator + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    cookies[name] = value;
  }

  return cookies;
}

/**
 * The `Set-Cookie` a login sends.
 *
 * `HttpOnly` keeps the token away from scripts, `SameSite=Lax` keeps a cross-site form
 * post from carrying it on anything but a top-level navigation, and `Path=/` makes it
 * apply to the API as a whole. `Secure` is added only when the deployment is served over
 * TLS: asking for it on plain http makes the browser drop the cookie, which turns into a
 * login that silently never sticks.
 */
export function serializeSessionCookie(
  token: string,
  options: { secure: boolean; maxAgeSeconds: number },
): string {
  const attributes = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${options.maxAgeSeconds}`,
  ];
  if (options.secure) attributes.push("Secure");
  return attributes.join("; ");
}

/** The `Set-Cookie` a logout sends: the same cookie, expired. */
export function clearSessionCookie(options: { secure: boolean }): string {
  return serializeSessionCookie("", { secure: options.secure, maxAgeSeconds: 0 });
}

/**
 * Start a session for `userId`.
 *
 * The caller gets the plain token exactly once — for the `Set-Cookie` — and the database
 * gets only its hash. Expired rows are swept opportunistically here rather than by a
 * scheduled job: a login is the one moment a stale row costs somebody a lookup, and it
 * keeps this module free of a background timer that would need its own lifecycle.
 */
export async function createSession(
  db: Database,
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db.query("DELETE FROM sessions WHERE expires_at < now()");
  await db.query(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
    [tokenHash(token), userId, expiresAt],
  );

  return { token, expiresAt };
}

/**
 * Who `token` belongs to, or `undefined`.
 *
 * An empty, unknown or expired token is `undefined` — never a throw — because the caller
 * is a header an anonymous request may or may not carry. A database that is DOWN is a
 * different matter and still surfaces as an error: reporting an outage as "you are not
 * signed in" would make every client quietly retry a login that cannot work.
 *
 * The join to `users` makes a session whose account was removed stop working immediately,
 * instead of surviving until its expiry.
 */
export async function resolveSession(
  db: Database,
  token: string,
): Promise<{ userId: string } | undefined> {
  if (typeof token !== "string" || token.length === 0) return undefined;

  const rows = await db.query<{ user_id: string }>(
    `SELECT s.user_id
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [tokenHash(token)],
  );

  const row = rows[0];
  return row ? { userId: row.user_id } : undefined;
}

/** End `token`'s session. An unknown or empty token is a no-op, so logout is idempotent. */
export async function deleteSession(db: Database, token: string): Promise<void> {
  if (typeof token !== "string" || token.length === 0) return;
  await db.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash(token)]);
}

/** How many distinct accounts the throttle will track before it sweeps expired windows. */
const MAX_TRACKED_KEYS = 10_000;

interface FailureWindow {
  failures: number;
  startedAt: number;
}

/**
 * A brute-force speed bump for login, per account.
 *
 * ## This is not durable security, on purpose
 *
 * The window is **per process** and lives in memory, so it is deliberately lost on
 * restart: several instances each count their own failures, a redeploy clears every
 * lock, and an attacker who can force restarts is not slowed by it at all. It is here to
 * make online guessing of one account expensive while the process stays up, not to be
 * the thing that protects a password. A real answer — a durable table, per-IP limits,
 * exponential backoff — costs a schema and a policy decision; this costs a `Map`, and
 * saying so here is cheaper than implying otherwise.
 *
 * A fixed window (the count resets only after `LOGIN_WINDOW_MS`) rather than a sliding
 * one: a sliding window costs a timestamp per failure to be slightly kinder to a client
 * that failed once, and this is a speed bump.
 */
export class LoginThrottle {
  private readonly windows = new Map<string, FailureWindow>();

  /** Is this account locked out right now? */
  isLocked(key: string): boolean {
    const window = this.windows.get(key);
    if (!window) return false;
    if (this.expired(window)) {
      this.windows.delete(key);
      return false;
    }
    return window.failures >= LOGIN_MAX_FAILURES;
  }

  /** Count one failed attempt. The first failure of a window starts the clock. */
  recordFailure(key: string): void {
    const window = this.windows.get(key);
    if (!window || this.expired(window)) {
      if (this.windows.size >= MAX_TRACKED_KEYS) this.sweep();
      this.windows.set(key, { failures: 1, startedAt: Date.now() });
      return;
    }
    window.failures += 1;
  }

  /** Forget an account's failures: called on a successful login. */
  reset(key: string): void {
    this.windows.delete(key);
  }

  /**
   * Drop expired windows when the map is large.
   *
   * The keys are caller-supplied account names, and `/login` is unauthenticated, so an
   * attacker can make this map grow with names that do not exist. Sweeping keeps the
   * memory bounded; an attacker who reaches the bound can also evict a lock, which is
   * accepted: a truthfully-bounded speed bump beats an unbounded one.
   */
  private sweep(): void {
    for (const [key, window] of this.windows) {
      if (this.expired(window)) this.windows.delete(key);
    }
  }

  private expired(window: FailureWindow): boolean {
    return Date.now() - window.startedAt >= LOGIN_WINDOW_MS;
  }
}
