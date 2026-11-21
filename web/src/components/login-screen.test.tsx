import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LoginScreen } from "./login-screen.tsx";

/**
 * WHAT THIS FILE PINS (S1)
 *
 * The login surface takes a user and a password and nothing else: no email, no URL
 * token, no "remember me", and no create-account form — S4 asked for an ENDPOINT, not
 * a screen. The two refusals a person can act on are shown in their exact words, one
 * click is one request, and a failure is never dressed up as success.
 */

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A stubbed `/api/login` that records what the form actually sent. */
function stubLogin(handler: () => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init: RequestInit = {}) => {
      const raw = typeof init.body === "string" ? init.body : null;
      calls.push({
        method: (init.method ?? "GET").toUpperCase(),
        url: String(input),
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
      });
      return handler();
    }),
  );
  return calls;
}

const ALICE = { id: "alice", displayName: "Alice" };

function fill(user: string, password: string): void {
  fireEvent.change(screen.getByLabelText("User"), { target: { value: user } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the login surface asks for a user and a password", () => {
  it("has exactly two inputs, and nothing that accepts a token, an email or a new account", () => {
    stubLogin(() => json({ user: ALICE }));
    render(<LoginScreen onSignedIn={() => {}} />);

    expect(document.querySelectorAll("input")).toHaveLength(2);
    expect(screen.getByLabelText("User")).toBeDefined();
    expect(screen.getByLabelText("Password")).toBeDefined();

    // The ways a third thing could sneak back in: a field for it, or a control that
    // asks for one.
    expect(screen.queryAllByLabelText(/e-?mail/i)).toHaveLength(0);
    expect(screen.queryAllByLabelText(/token/i)).toHaveLength(0);
    expect(screen.queryAllByText(/remember me/i)).toHaveLength(0);
    expect(screen.queryAllByText(/create account|sign up|register/i)).toHaveLength(0);
    expect(document.querySelectorAll("input[type=checkbox]")).toHaveLength(0);
  });

  it("masks the password, and tells the browser which manager fields these are", () => {
    stubLogin(() => json({ user: ALICE }));
    render(<LoginScreen onSignedIn={() => {}} />);

    const password = screen.getByLabelText("Password") as HTMLInputElement;
    expect(password.type).toBe("password");
    expect(password.getAttribute("autocomplete")).toBe("current-password");
    expect(screen.getByLabelText("User").getAttribute("autocomplete")).toBe("username");
  });

  it("sends the trimmed user and the password exactly as typed", async () => {
    const calls = stubLogin(() => json({ user: ALICE }));
    const onSignedIn = vi.fn();
    render(<LoginScreen onSignedIn={onSignedIn} />);

    fill("  alice  ", " s3cret ");
    fireEvent.click(submitButton());

    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("/api/login");
    // The user is trimmed. The password is NOT: its spaces are part of it.
    expect(calls[0]?.body).toEqual({ user: "alice", password: " s3cret " });
    // And the identity the server named is what the caller is handed.
    expect(onSignedIn).toHaveBeenCalledWith(ALICE);
  });

  it("says exactly 'User or password is incorrect' on a 401, and signs nobody in", async () => {
    stubLogin(() => json({ error: "invalid_credentials", message: "invalid credentials" }, 401));
    const onSignedIn = vi.fn();
    render(<LoginScreen onSignedIn={onSignedIn} />);

    fill("alice", "wrong");
    fireEvent.click(submitButton());

    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(screen.getByRole("alert").textContent).toBe("User or password is incorrect");
    expect(onSignedIn).not.toHaveBeenCalled();
    // The form is still there, with the account still typed in: a refusal is not a
    // reason to make someone start over.
    expect((screen.getByLabelText("User") as HTMLInputElement).value).toBe("alice");
  });

  it("says exactly 'Too many failed attempts; try again later' on a 429", async () => {
    stubLogin(() => json({ error: "too_many_attempts", message: "too many attempts" }, 429));
    const onSignedIn = vi.fn();
    render(<LoginScreen onSignedIn={onSignedIn} />);

    fill("alice", "wrong");
    fireEvent.click(submitButton());

    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(screen.getByRole("alert").textContent).toBe(
      "Too many failed attempts; try again later",
    );
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("disables the submit while a request is in flight, and a second click sends nothing", async () => {
    let release!: (response: Response) => void;
    const calls = stubLogin(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const onSignedIn = vi.fn();
    render(<LoginScreen onSignedIn={onSignedIn} />);

    fill("alice", "s3cret");
    fireEvent.click(submitButton());
    await waitFor(() => expect(calls).toHaveLength(1));

    // Disabled, and the double click that would otherwise be a second login attempt.
    expect(submitButton().disabled).toBe(true);
    fireEvent.click(submitButton());
    fireEvent.submit(submitButton().closest("form") as HTMLFormElement);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toHaveLength(1);

    release(json({ user: ALICE }));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(ALICE));
  });

  it("submits from the form — what Enter in either field does — with focus in the user field first", async () => {
    const calls = stubLogin(() => json({ user: ALICE }));
    const onSignedIn = vi.fn();
    render(<LoginScreen onSignedIn={onSignedIn} />);

    expect(document.activeElement).toBe(screen.getByLabelText("User"));

    fill("alice", "s3cret");
    const form = screen.getByLabelText("User").closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(ALICE));
    expect(calls).toHaveLength(1);
  });

  it("shows the server's own words when the request itself was refused", async () => {
    // A 400 is not a wrong password: telling someone their password is wrong when the
    // body it sent was rejected would send them looking for the wrong fix.
    stubLogin(() =>
      json({ error: "invalid_request", message: "Password must be between 8 and 200 characters" }, 400),
    );
    render(<LoginScreen onSignedIn={() => {}} />);

    fill("alice", "short");
    fireEvent.click(submitButton());

    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(screen.getByRole("alert").textContent).toBe(
      "Password must be between 8 and 200 characters",
    );
  });

  it("says the server could not be reached instead of calling the password wrong", async () => {
    stubLogin(() => {
      throw new Error("ECONNREFUSED");
    });
    const onSignedIn = vi.fn();
    render(<LoginScreen onSignedIn={onSignedIn} />);

    fill("alice", "s3cret");
    fireEvent.click(submitButton());

    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(screen.getByRole("alert").textContent).toBe(
      "Cannot reach the server. Try again in a moment.",
    );
    expect(onSignedIn).not.toHaveBeenCalled();
    // And the form is usable again rather than stuck disabled.
    await waitFor(() => expect(submitButton().disabled).toBe(false));
  });
});
