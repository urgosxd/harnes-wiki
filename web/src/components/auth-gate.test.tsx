import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AuthGate } from "./AuthGate.tsx";

describe("AuthGate", () => {
  it("asks for a name and a token instead of showing an empty chat", () => {
    render(<AuthGate error={null} initialUser="" initialToken="" onContinue={() => {}} />);
    expect(screen.getByText("Sign in")).toBeDefined();
    expect(screen.getByLabelText("Your name")).toBeDefined();
    expect(screen.getByLabelText("Access token")).toBeDefined();
  });

  it("continues with the typed values", () => {
    const onContinue = vi.fn();
    render(<AuthGate error={null} initialUser="" initialToken="" onContinue={onContinue} />);

    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "bob" } });
    fireEvent.change(screen.getByLabelText("Access token"), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByText("Continue"));

    expect(onContinue).toHaveBeenCalledWith("bob", "s3cret");
  });

  it("shows why the previous attempt failed", () => {
    render(
      <AuthGate error="That token was rejected by the server." initialUser="alice" initialToken="" onContinue={() => {}} />,
    );
    expect(screen.getByRole("alert").textContent).toContain("rejected");
  });

  it("does not continue with an empty value", () => {
    const onContinue = vi.fn();
    render(<AuthGate error={null} initialUser="" initialToken="" onContinue={onContinue} />);
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "   " } });
    fireEvent.click(screen.getByText("Continue"));
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("prefills the previous name so a retry is one field", () => {
    render(<AuthGate error={null} initialUser="carol" initialToken="" onContinue={() => {}} />);
    expect((screen.getByLabelText("Your name") as HTMLInputElement).value).toBe("carol");
  });
});
