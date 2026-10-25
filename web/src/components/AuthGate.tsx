import { useState, type FormEvent } from "react";

export interface AuthGateProps {
  /** Shown when the current identity was rejected, so the screen is not a mystery. */
  error: string | null;
  initialUser: string;
  initialToken: string;
  onContinue(user: string, token: string): void;
}

/**
 * The first screen when no usable identity is present.
 *
 * The API refuses anonymous requests by design, and a blank chat window with a 401
 * in the console is the worst possible way to learn that. This asks for the two
 * values the development authenticator needs and stores them in the URL, so a
 * reload keeps working and the link can be shared with a teammate.
 */
export function AuthGate({ error, initialUser, initialToken, onContinue }: AuthGateProps) {
  const [user, setUser] = useState(initialUser || "alice");
  const [token, setToken] = useState(initialToken || "dev");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmedUser = user.trim();
    const trimmedToken = token.trim();
    if (!trimmedUser || !trimmedToken) return;
    onContinue(trimmedUser, trimmedToken);
  };

  return (
    <div className="gate">
      <form className="gate__card" onSubmit={submit}>
        <h1 className="gate__title">Sign in</h1>
        <p className="gate__hint">
          This build has no real authentication. Pick any name to get your own
          conversations; the token is the one the server was started with.
        </p>

        {error && (
          <p className="gate__error" role="alert">
            {error}
          </p>
        )}

        <label className="gate__field">
          <span>Your name</span>
          <input
            className="gate__input"
            value={user}
            onChange={(event) => setUser(event.target.value)}
            autoComplete="off"
            autoFocus
          />
        </label>

        <label className="gate__field">
          <span>Access token</span>
          <input
            className="gate__input"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="off"
            type="password"
          />
        </label>

        <button type="submit" className="button button--primary gate__submit">
          Continue
        </button>
      </form>
    </div>
  );
}
