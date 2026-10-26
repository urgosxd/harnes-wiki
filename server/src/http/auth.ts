import type { IncomingMessage } from "node:http";
import { parseRoster, resolveRosterUser, type RosterUser } from "./users.ts";

/**
 * Resolve the caller's user id.
 *
 * This is a seam, not an implementation: the product needs real authentication
 * (session cookie or a signed token from an identity provider), and inventing a
 * scheme here would hide that decision. Two rules are fixed:
 *
 *  - A request without a resolvable identity is refused. There is no anonymous
 *    default, because an anonymous default is how one user ends up reading
 *    another user's conversation.
 *  - The id comes from the request only. It is never read from a body field or a
 *    query parameter, which a client could set to someone else's id.
 */
export type Authenticator = (req: IncomingMessage) => Promise<string | undefined>;

export interface AuthConfig {
  /**
   * `id:token,id:token`. Each user has their own secret, so claiming another name
   * with your own token is refused. This is the local roster for trying the product
   * with a couple of people, not real authentication.
   */
  users?: string | undefined;
  /**
   * Legacy single shared token. Still honoured when `users` is absent, and it keeps
   * the old weakness: anyone holding it can claim any user id.
   */
  devToken?: string | undefined;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function createAuthenticator(config: AuthConfig): Authenticator {
  const roster: RosterUser[] = parseRoster(config.users);
  if (roster.length > 0) {
    return async (req) => {
      const user = resolveRosterUser({
        users: roster,
        token: header(req, "x-dev-token"),
        claimedUserId: header(req, "x-user-id"),
      });
      return user?.id;
    };
  }

  const sharedToken = config.devToken;
  if (!sharedToken) {
    // Fail closed. Every request is unauthorized until identity is configured.
    return async () => undefined;
  }

  // Legacy mode: one token for everyone, so the claimed id is trusted. Kept only so
  // an existing setup keeps working; the roster is the recommended path.
  return async (req) => {
    const provided = header(req, "x-dev-token");
    if (provided !== sharedToken) return undefined;

    const userId = header(req, "x-user-id");
    if (!userId || !/^[A-Za-z0-9._@-]{1,128}$/.test(userId)) return undefined;
    return userId;
  };
}
