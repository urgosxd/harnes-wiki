import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Identity } from "../lib/api.ts";
import { signIn, type SignInResult } from "../lib/session.ts";

export interface LoginScreenProps {
  /** Called with the identity the SERVER named, which is the only identity trusted. */
  onSignedIn(user: Identity): void;
}

/**
 * The sign-in surface: a user and a password (S1), and nothing else.
 *
 * There is no create-account form here on purpose. S4 asked for an ENDPOINT that creates
 * users, not for a screen; adding one would also mean deciding, on this screen, who is
 * allowed to create whom — a question this feature answers with "anyone signed in".
 *
 * The three failure copies are the ones a person can act on: wrong credentials, a
 * throttle, and the server's own words for a rejected request. Everything else is a
 * transport failure and says so, because a server that did not answer is not a reason to
 * send somebody hunting for a different password.
 */
export function LoginScreen({ onSignedIn }: LoginScreenProps) {
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const userField = useRef<HTMLInputElement>(null);
  /**
   * A second gate beside `pending`: state is not guaranteed to have flushed between two
   * submits in the same tick, and two logins are two tries against the throttle.
   */
  const inFlight = useRef(false);

  useEffect(() => {
    userField.current?.focus();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);

    try {
      // The user is trimmed (a name pasted from a chat arrives with whitespace); the
      // password is sent exactly as typed, spaces included.
      const result = await signIn(user.trim(), password);
      if (result.kind === "ok") {
        // Stays disabled: the parent replaces this screen on this callback, and a form
        // that re-enables itself could fire a second, pointless login.
        onSignedIn(result.user);
        return;
      }
      setError(copyFor(result));
    } catch {
      setError("Cannot reach the server. Try again in a moment.");
    }

    // Only reached when the attempt did not sign anybody in.
    inFlight.current = false;
    setPending(false);
  }

  return (
    <div className="gate">
      <form className="gate__card" onSubmit={(event) => void submit(event)}>
        <h1 className="gate__title">Sign in</h1>

        <label className="gate__field">
          <span>User</span>
          <input
            ref={userField}
            className="gate__input"
            type="text"
            name="user"
            autoComplete="username"
            spellCheck={false}
            value={user}
            onChange={(event) => setUser(event.target.value)}
          />
        </label>

        <label className="gate__field">
          <span>Password</span>
          <input
            className="gate__input"
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        {error && (
          <p className="gate__error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="button button--primary gate__submit" disabled={pending}>
          Sign in
        </button>
      </form>
    </div>
  );
}

/** What the screen says for each answer the session gave. */
function copyFor(result: SignInResult): string {
  switch (result.kind) {
    case "invalid_credentials":
      return "User or password is incorrect";
    case "too_many_attempts":
      return "Too many failed attempts; try again later";
    case "invalid_request":
      // The server names the broken rule; rewording it here would hide it.
      return result.message;
    case "ok":
      // Unreachable: a success hands the identity to the parent above. Kept for the
      // exhaustive switch, so a new answer has to be given copy deliberately.
      return "";
  }
}
