import { ApiClient, ApiError, type Identity } from "./api.ts";

/**
 * The browser's side of the cookie session.
 *
 * ## What this module deliberately does NOT have
 *
 * No token. Anywhere. Not in `localStorage`, not in `sessionStorage`, not in a module
 * variable, not in a React state: the server sets an `HttpOnly` cookie, the browser
 * attaches it to every request on its own, and this code never sees the value. A copy
 * kept in JavaScript would be readable by any script on the page, which is exactly what
 * `HttpOnly` exists to prevent — so there is nothing here to leak.
 *
 * ## Why it is a module and not three lines in `App.tsx`
 *
 * The three calls have three different failure vocabularies, and each one is a product
 * decision rather than a transport detail: a 401 from `/me` means "nobody is signed in"
 * (a normal state, not an error), a 401 from `/login` means "wrong user or password"
 * (something the person can fix), and every other failure is a real error the screen has
 * to show. Writing that mapping once, next to the tests that pin it, is what keeps the
 * login screen from inventing a fourth opinion.
 *
 * ## Why a client per call
 *
 * `ApiClient` binds its transport when it is constructed, so a client built at import
 * time would capture whatever `fetch` existed then. Building one per call keeps the base
 * URL, the JSON headers and the error shape in ONE place (`api.ts`) while leaving the
 * transport resolved at request time.
 */

/** Nobody is signed in, or here is who is. Two facts, not an error and a value. */
export type IdentityResolution =
  | { kind: "authenticated"; user: Identity }
  | { kind: "signed-out" };

/** Every answer a sign-in attempt can have, including the two a person can act on. */
export type SignInResult =
  | { kind: "ok"; user: Identity }
  | { kind: "invalid_credentials" }
  | { kind: "too_many_attempts" }
  | { kind: "invalid_request"; message: string };

function client(): ApiClient {
  // No identity headers on purpose: the cookie IS the identity, and adding a second one
  // would be a claim the server is right to ignore.
  return new ApiClient({ headers: () => ({}) });
}

/**
 * Ask the session who it belongs to.
 *
 * A 401 is `signed-out` — the ordinary state of a first visit — and NOT a failure. Every
 * other outcome (a 500, a network that never answered, a body that is not JSON) throws,
 * because telling somebody with a working session that they are signed out would send
 * them to a login form that cannot explain what actually happened.
 */
export async function fetchIdentity(): Promise<IdentityResolution> {
  try {
    const user = await client().me();
    return { kind: "authenticated", user };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return { kind: "signed-out" };
    throw error;
  }
}

/**
 * Try to sign in.
 *
 * The user is trimmed by the caller (the form), not here: this function sends what it is
 * given, so the wire shows exactly what the screen decided to send. A password is never
 * trimmed — its spaces are part of it.
 */
export async function signIn(user: string, password: string): Promise<SignInResult> {
  try {
    const identity = await client().login(user, password);
    return { kind: "ok", user: identity };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 401) return { kind: "invalid_credentials" };
      if (error.status === 429) return { kind: "too_many_attempts" };
      // 400 is the server rejecting the request itself, and its message says which rule
      // was broken — the person can only act on it in the server's own words.
      if (error.status === 400) return { kind: "invalid_request", message: error.message };
    }
    throw error;
  }
}

/**
 * End the session.
 *
 * Throws when the server did not answer `204`: the cookie is still valid in that case,
 * and a UI that pretended otherwise would show a login form the next request would walk
 * straight back through.
 */
export async function signOut(): Promise<void> {
  await client().logout();
}
