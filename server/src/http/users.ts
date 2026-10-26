import { timingSafeEqual } from "node:crypto";

/**
 * Two fixed users, each with their own secret.
 *
 * The previous scheme had one shared `DEV_AUTH_TOKEN` and took the user id from a
 * header the browser sends. Measured consequence: with the same shared token, one
 * user could open another's conversation simply by claiming their id — the request
 * came back 200 with the title visible. A user id that the client chooses is not an
 * identity.
 *
 * This is still not real authentication: it is a fixed local roster for trying the
 * product with two people. What it does provide is the property that matters for
 * that test — each person has a secret the other does not, so claiming someone
 * else's name is not enough.
 *
 * Replacing this with a session cookie or a verified JWT means implementing the
 * same `Authenticator` contract; nothing else in the system changes.
 */
export interface RosterUser {
  id: string;
  displayName: string;
  token: string;
}

/**
 * Parse `CHAT_USERS` as `id:token,id:token`.
 *
 * Tokens must be long enough to not be guessable, because with two users guessing
 * is the whole attack: a six-character token is 36^6 and a script finds it.
 */
export function parseRoster(raw: string | undefined): RosterUser[] {
  if (!raw?.trim()) return [];

  const users: RosterUser[] = [];
  const seen = new Set<string>();

  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      throw new Error(`CHAT_USERS entry "${trimmed}" must be id:token`);
    }
    const id = trimmed.slice(0, separator).trim();
    const token = trimmed.slice(separator + 1).trim();

    if (!/^[A-Za-z0-9._@-]{1,64}$/.test(id)) {
      throw new Error(`CHAT_USERS id "${id}" must match [A-Za-z0-9._@-] and be at most 64 characters`);
    }
    if (token.length < 16) {
      throw new Error(
        `CHAT_USERS token for "${id}" is too short (${token.length}); use at least 16 characters`,
      );
    }
    if (seen.has(id)) throw new Error(`CHAT_USERS declares "${id}" twice`);
    seen.add(id);
    users.push({ id, displayName: id, token });
  }

  if (users.length === 0) throw new Error("CHAT_USERS declared no users");
  return users;
}

/** Constant-time token comparison, so a wrong guess leaks no timing signal. */
export function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual requires equal lengths; the length itself is not secret.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Resolve a request to a user.
 *
 * The token identifies the user; the `x-user-id` header is only accepted when it
 * agrees with that token's user. A mismatch is refused rather than ignored, so a
 * client sending the wrong pair learns it is wrong instead of silently acting as
 * somebody else.
 */
export function resolveRosterUser(options: {
  users: readonly RosterUser[];
  token: string | undefined;
  claimedUserId: string | undefined;
}): RosterUser | undefined {
  const { users, token, claimedUserId } = options;
  if (!token) return undefined;

  const match = users.find((user) => tokenMatches(token, user.token));
  if (!match) return undefined;

  if (claimedUserId !== undefined && claimedUserId !== match.id) return undefined;
  return match;
}

/** Public identity for the client: no token. */
export function publicUser(user: RosterUser): { id: string; displayName: string } {
  return { id: user.id, displayName: user.displayName };
}
