import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiClient, type Identity } from "./lib/api.ts";
import { fetchIdentity, signOut } from "./lib/session.ts";
import { parseStackId } from "./lib/tenant.ts";
import { useChat } from "./lib/use-chat.ts";
import { useIngest } from "./lib/use-ingest.ts";
import { LoginScreen } from "./components/login-screen.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { ChatWindow } from "./components/ChatWindow.tsx";
import { IngestJobsPanel } from "./components/IngestJobsPanel.tsx";

/**
 * The product, once there is a session.
 *
 * ## Where identity comes from (S1, S3)
 *
 * The session cookie, and nothing else. The URL no longer names a user or carries a
 * token — `?user=` and `?token=` are dead — and no request carries `x-user-id` or
 * `x-dev-token` any more. `App` asks `GET /api/me` once, on mount, and the answer decides
 * which of four screens is shown:
 *
 *   loading     — a neutral "Connecting…", never a flash of the login form or of somebody
 *                 else's conversations;
 *   authenticated — the product, with the account the server named;
 *   signed-out  — the login form;
 *   unreachable — an error and a retry, because a server that did not answer is not an
 *                 identity problem and must not be reported as one.
 *
 * ## What stays exactly as it was (S2)
 *
 * `parseStackId(window.location.search)` and the `x-stack-id` header. The Stack is a
 * SELECTION, read once at mount from the link, and a link without one is still blocked at
 * the ingest surface — but only for a signed-in person: an unauthenticated visit shows
 * the login form, not a link error (S3).
 */
type Gate =
  | { kind: "loading" }
  | { kind: "unreachable" }
  | { kind: "signed-out" }
  | { kind: "authenticated"; user: Identity };

export function App() {
  // The tenant comes from the link, read once at mount. There is no env var, no picker
  // and no remembered value behind it: a link without a Stack is blocked, which is why a
  // reload cannot silently re-scope the session.
  const [stackId] = useState<string | null>(() => {
    const resolution = parseStackId(window.location.search);
    return resolution.ok ? resolution.stackId : null;
  });

  const [gate, setGate] = useState<Gate>({ kind: "loading" });
  /** Bumped by the retry, which is the only thing that re-asks the session. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchIdentity()
      .then((resolution) => {
        if (cancelled) return;
        setGate(
          resolution.kind === "authenticated"
            ? { kind: "authenticated", user: resolution.user }
            : { kind: "signed-out" },
        );
      })
      .catch(() => {
        // A 500 or a network that never answered: NOT "signed out". Saying so would send
        // a person with a working session to a form the server cannot answer.
        if (!cancelled) setGate({ kind: "unreachable" });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // Stable identities: `Session` builds its client from these, and a new function every
  // render would rebuild the client and restart every read that depends on it.
  const handleSignedIn = useCallback((user: Identity) => {
    setGate({ kind: "authenticated", user });
  }, []);
  const handleSignedOut = useCallback(() => setGate({ kind: "signed-out" }), []);
  const retry = useCallback(() => {
    setGate({ kind: "loading" });
    setAttempt((current) => current + 1);
  }, []);

  if (gate.kind === "loading") return <div className="boot">Connecting…</div>;
  if (gate.kind === "unreachable") return <Unreachable onRetry={retry} />;
  if (gate.kind === "signed-out") return <LoginScreen onSignedIn={handleSignedIn} />;

  // Remounting on identity change is deliberate: a different user must not inherit the
  // previous user's conversations or in-flight stream.
  return (
    <Session
      key={gate.user.id}
      identity={gate.user}
      stackId={stackId}
      onSignedOut={handleSignedOut}
    />
  );
}

/** The only screen shown when the session could not be read at all. */
function Unreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="gate">
      <div className="gate__card">
        <h1 className="gate__title">Cannot reach the server</h1>
        <p className="gate__hint">The server did not answer. Try again in a moment.</p>
        <button type="button" className="button button--primary gate__submit" onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  );
}

function Session({
  identity,
  stackId,
  onSignedOut,
}: {
  identity: Identity;
  /** The tenant from the link, or `null` when it named none. */
  stackId: string | null;
  onSignedOut(): void;
}) {
  const client = useMemo(
    () =>
      new ApiClient({
        // No identity header: the cookie carries the identity, and the browser sends it
        // on its own. The one header this client adds is the tenant from the link, only
        // when the link named one — the agent's Stack-scoped tools read this Stack, and
        // with no header they fail closed rather than reading whatever the server
        // happens to default to.
        headers: () => (stackId ? { "x-stack-id": stackId } : {}),
        // A 401 mid-session means the session is gone: expired, or signed out from
        // another tab. Asking for the password again is the only honest answer, and it
        // is also the only one that works.
        onUnauthorized: onSignedOut,
      }),
    [stackId, onSignedOut],
  );

  // Built once here, not inside the panel: the poll loop must survive a switch to
  // the chat tab and back, otherwise returning to the view would restart a poll
  // for a job that is already being followed.
  const ingest = useIngest({ client, stackId });
  const chat = useChat({ client });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [view, setView] = useState<"chat" | "jobs">("chat");
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  async function handleSignOut(): Promise<void> {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError(null);
    try {
      await signOut();
      onSignedOut();
      // Stays disabled: the parent replaces this screen on this callback.
      return;
    } catch {
      // The cookie is still valid, so claiming success would be a lie the next request
      // would expose.
      setSignOutError("Could not sign out. Try again.");
    }
    setSigningOut(false);
  }

  /*
   * Where the account is shown, the way out of it belongs too. The layout has no room
   * reserved for it (the sidebar footer is one line of text), so this is pinned to the
   * corner: visible without restructuring a layout this change has no business moving.
   */
  const signOutBar = (
    <div
      style={{
        position: "fixed",
        top: 12,
        right: 12,
        zIndex: 20,
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      {signOutError && (
        <span role="alert" style={{ fontSize: 12, color: "var(--error)" }}>
          {signOutError}
        </span>
      )}
      <button
        type="button"
        className="button button--small"
        onClick={() => void handleSignOut()}
        disabled={signingOut}
      >
        Sign out
      </button>
    </div>
  );

  if (view === "jobs") {
    return (
      <>
        {signOutBar}
        <IngestJobsPanel ingest={ingest} onClose={() => setView("chat")} />
      </>
    );
  }

  return (
    <>
      {signOutBar}
      <div className="app">
        <Sidebar
          conversations={chat.conversations}
          activeId={chat.activeId}
          loading={chat.loadingList}
          error={chat.listError}
          open={sidebarOpen}
          user={identity.displayName}
          onSelect={(id) => {
            setSidebarOpen(false);
            void chat.openConversation(id);
          }}
          onNew={() => {
            setSidebarOpen(false);
            chat.newConversation();
          }}
          onDelete={(id) => void chat.remove(id)}
          onClose={() => setSidebarOpen(false)}
          onOpenJobs={() => setView("jobs")}
        />

        <ChatWindow
          state={chat.state}
          conversationId={chat.activeId}
          loadingThread={chat.loadingThread}
          onSend={(text) => void chat.send(text)}
          onRetry={chat.retry}
          onStop={chat.stop}
          onOpenSidebar={() => setSidebarOpen(true)}
        />
      </div>
    </>
  );
}
