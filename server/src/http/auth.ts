import type { IncomingMessage } from "node:http";
import type { Database } from "../db/pool.ts";
import { parseRoster, resolveRosterUser, type RosterUser } from "./users.ts";
import { SESSION_COOKIE, parseCookies, resolveSession } from "./sessions.ts";

/**
 * Resolve the caller's user id.
 *
 * Four modes, and the difference between them is the only thing that matters here:
 * **whether the claimed id can be checked against a secret.**
 *
 *  - `password`: the caller signs in with an account and a password, and identity comes
 *    from the session cookie. The product's mode, and the only one where the caller has
 *    to prove something to BE a user.
 *  - `roster`: each user has their own token, so a claimed id that disagrees with
 *    the token is refused. The only legacy mode that resists impersonation.
 *  - `shared-token`: one token for everyone. It proves the caller was given the
 *    token, and proves nothing about WHICH user they are.
 *  - `open`: no secret at all. The claimed id IS the identity.
 *
 * ## What `open` is not
 *
 * It is not authentication and it cannot be made into authentication. There is no
 * secret to compare a claim against, so `?user=alice` is alice, for anybody holding
 * any link. A request is refused only when the id is absent or malformed.
 *
 * Validating the FORMAT is not security: it exists so an empty id cannot share one
 * bucket between every caller, and so a slash or a space cannot reach the database
 * as a `user_id` or split a log line. Calling that "validation of the user" would be
 * a claim of control where there is none.
 *
 * Two rules stay fixed across all three modes:
 *
 *  - A request without a resolvable identity is refused. There is no anonymous
 *    default, because an anonymous default silently merges everyone's data.
 *  - The id never comes from a body field or a query parameter, which a client could
 *    set to someone else's id. Legacy modes read it from headers because there is no
 *    session to read it from; `password` mode reads the cookie and nothing else.
 */
export type Authenticator = (req: IncomingMessage) => Promise<string | undefined>;

/**
 * Which scheme resolves identity. Explicit rather than inferred from which values
 * happen to be configured: an operator who switches the mechanism should not have
 * to reason about the precedence of an empty string versus an undefined one.
 */
export type AuthMode = "password" | "roster" | "shared-token" | "open";

/**
 * What a deployment runs with when nothing is configured.
 *
 * `password`, never `open`: forgetting `AUTH_MODE` used to be survivable because the
 * server refused everything, and it must not become a server that believes whatever
 * name a request claims. Expressed here, once, so no entry point can pick another.
 */
export const DEFAULT_AUTH_MODE: AuthMode = "password";

export interface AuthConfig {
  /**
   * Which rule applies. When omitted, the mode is inferred the old way: a roster if
   * one is configured, then a shared token, then `open`. Inference is kept so
   * existing callers keep working; new deployments should set it.
   */
  mode?: AuthMode | undefined;
  /**
   * `id:token,id:token`. Each user has their own secret, so claiming another name
   * with your own token is refused. This is the local roster for trying the product
   * with a couple of people, not real authentication.
   */
  users?: string | undefined;
  /**
   * Single shared token. It keeps the old weakness: anyone holding it can claim any
   * user id.
   */
  devToken?: string | undefined;
  /**
   * Where sessions are looked up. Required by `password` mode and ignored by the legacy
   * ones.
   *
   * Injected rather than imported so the router keeps holding no connection details:
   * the authenticator is a closure over one database handle, built by whoever already
   * has it. Without a handle, `password` mode refuses every request instead of throwing
   * on each one — the same fail-closed answer the modes above give.
   */
  db?: Database | undefined;
}

/** Ids that can safely become a `user_id` and a log field. */
const USER_ID_PATTERN = /^[A-Za-z0-9._@-]{1,64}$/;

/**
 * Read `AUTH_MODE`, refusing to guess at a typo.
 *
 * A misspelled mode is a configuration error with a security consequence, so it
 * throws at startup rather than falling back to whatever the other variables imply.
 * Empty means "not set", which lets the caller infer as before.
 */
export function parseAuthMode(raw: string | undefined): AuthMode | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (
    value === "password" ||
    value === "roster" ||
    value === "shared-token" ||
    value === "open"
  ) {
    return value;
  }
  throw new Error(
    `AUTH_MODE must be one of password, roster, shared-token, open, got "${value}"`,
  );
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Resolve which scheme to use, honouring an explicit choice above everything.
 *
 * With nothing configured the answer is `undefined`, which fails closed. Inference
 * must never fall FORWARD into the weakest mode: a server started without its
 * environment should refuse every request, not quietly become open to whoever can
 * reach it. `open` is therefore reachable only by asking for it.
 *
 * `undefined` here is not what a deployment runs with: `resolveDeploymentAuthMode`
 * turns it into `DEFAULT_AUTH_MODE`. Kept separate so the legacy inference stays exactly
 * as it was and the default lives in one readable place.
 */
export function resolveAuthMode(config: AuthConfig): AuthMode | undefined {
  if (config.mode) return config.mode;
  if (parseRoster(config.users).length > 0) return "roster";
  if (config.devToken) return "shared-token";
  return undefined;
}

/**
 * The mode a deployment ACTUALLY runs with: its explicit choice, then the legacy
 * inference, then `DEFAULT_AUTH_MODE`.
 *
 * A deployment that configured nothing gets password mode: it refuses every request
 * until accounts exist, which is the fail-closed posture this file has always had. A
 * deployment that configured a roster or a shared token keeps it — those modes stay for
 * tests and for setups that already run them.
 */
export function resolveDeploymentAuthMode(config: AuthConfig): AuthMode {
  return resolveAuthMode(config) ?? DEFAULT_AUTH_MODE;
}

export function createAuthenticator(config: AuthConfig): Authenticator {
  const mode = resolveAuthMode(config);

  if (!mode) {
    // Fail closed. Every request is unauthorized until identity is configured, and
    // this is the one place where a missing setting is not a licence to guess.
    return async () => undefined;
  }

  if (mode === "password") {
    const db = config.db;
    // No database, no sessions, no identity. Refusing is the only honest answer; the
    // alternative is throwing on every request of a misconfigured deployment.
    if (!db) return async () => undefined;

    // Identity comes from the session and from nothing else: no header carries a
    // verified name in this mode, so reading one here would undo the whole feature.
    return async (req) => {
      const token = parseCookies(header(req, "cookie"))[SESSION_COOKIE];
      if (!token) return undefined;
      const session = await resolveSession(db, token);
      return session?.userId;
    };
  }

  if (mode === "roster") {
    const roster: RosterUser[] = parseRoster(config.users);
    if (roster.length === 0) {
      // Asking for the roster explicitly without providing one is a configuration
      // error, not a reason to silently fall through to a weaker mode.
      return async () => undefined;
    }
    return async (req) => {
      const user = resolveRosterUser({
        users: roster,
        token: header(req, "x-dev-token"),
        claimedUserId: header(req, "x-user-id"),
      });
      return user?.id;
    };
  }

  if (mode === "shared-token") {
    const sharedToken = config.devToken;
    if (!sharedToken) return async () => undefined;

    // One token for everyone, so the claimed id is trusted.
    return async (req) => {
      const provided = header(req, "x-dev-token");
      if (provided !== sharedToken) return undefined;

      const userId = header(req, "x-user-id")?.trim();
      if (!userId || !USER_ID_PATTERN.test(userId)) return undefined;
      return userId;
    };
  }

  // Open mode: the claimed id is the identity. Deliberately no token check — see the
  // file comment for why pretending otherwise would be worse than saying so.
  return async (req) => {
    const userId = header(req, "x-user-id")?.trim();
    if (!userId || !USER_ID_PATTERN.test(userId)) return undefined;
    return userId;
  };
}
