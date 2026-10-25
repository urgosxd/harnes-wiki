import type { IncomingMessage } from "node:http";

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
   * Development authenticator: trusts a shared token and takes the user id from a
   * header. Refused unless explicitly enabled, and never valid in production.
   */
  devToken?: string | undefined;
}

export function createAuthenticator(config: AuthConfig): Authenticator {
  if (!config.devToken) {
    // Fail closed. Every request is unauthorized until real auth is wired.
    return async () => undefined;
  }

  const token = config.devToken;
  return async (req) => {
    const provided = req.headers["x-dev-token"];
    const value = Array.isArray(provided) ? provided[0] : provided;
    if (value !== token) return undefined;

    const user = req.headers["x-user-id"];
    const userId = Array.isArray(user) ? user[0] : user;
    if (!userId || !/^[A-Za-z0-9._@-]{1,128}$/.test(userId)) return undefined;
    return userId;
  };
}
