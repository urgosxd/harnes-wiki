import type { IncomingMessage } from "node:http";
import { parseRoster, resolveRosterUser, type RosterUser } from "./users.ts";

/**
 * Resolve the caller's user id.
 *
 * Three modes, and the difference between them is the only thing that matters here:
 * **whether the claimed id can be checked against a secret.**
 *
 *  - `roster`: each user has their own token, so a claimed id that disagrees with
 *    the token is refused. The only mode that resists impersonation.
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
 *  - The id comes from the request headers only. It is never read from a body field
 *    or a query parameter, which a client could set to someone else's id.
 */
export type Authenticator = (req: IncomingMessage) => Promise<string | undefined>;

/**
 * Which scheme resolves identity. Explicit rather than inferred from which values
 * happen to be configured: an operator who switches the mechanism should not have
 * to reason about the precedence of an empty string versus an undefined one.
 */
export type AuthMode = "roster" | "shared-token" | "open";

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
  if (value === "roster" || value === "shared-token" || value === "open") return value;
  throw new Error(
    `AUTH_MODE must be one of roster, shared-token, open, got "${value}"`,
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
 */
export function resolveAuthMode(config: AuthConfig): AuthMode | undefined {
  if (config.mode) return config.mode;
  if (parseRoster(config.users).length > 0) return "roster";
  if (config.devToken) return "shared-token";
  return undefined;
}

export function createAuthenticator(config: AuthConfig): Authenticator {
  const mode = resolveAuthMode(config);

  if (!mode) {
    // Fail closed. Every request is unauthorized until identity is configured, and
    // this is the one place where a missing setting is not a licence to guess.
    return async () => undefined;
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
