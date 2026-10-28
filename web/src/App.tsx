import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiClient, ApiError, type Identity } from "./lib/api.ts";
import { useChat } from "./lib/use-chat.ts";
import { useIngest } from "./lib/use-ingest.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { ChatWindow } from "./components/ChatWindow.tsx";
import { AuthGate } from "./components/AuthGate.tsx";
import { IngestJobsPanel } from "./components/IngestJobsPanel.tsx";

/**
 * Identity from the URL: `?user=alice&token=...`.
 *
 * The token, not the name, is what identifies the caller. Each user has their own
 * secret (`CHAT_USERS`), so a link carrying the wrong pair is refused by the server
 * rather than silently acting as somebody else.
 */
interface Credentials {
  user: string;
  token: string;
}

function credentialsFromUrl(): Credentials | null {
  const params = new URLSearchParams(window.location.search);
  const user = params.get("user")?.trim();
  const token = params.get("token")?.trim();
  if (!user || !token) return null;
  return { user, token };
}

function writeCredentialsToUrl(credentials: Credentials): void {
  const params = new URLSearchParams(window.location.search);
  params.set("user", credentials.user);
  params.set("token", credentials.token);
  window.history.replaceState(null, "", `?${params.toString()}`);
}

export function App() {
  const [credentials, setCredentials] = useState<Credentials | null>(credentialsFromUrl);

  const continueAs = useCallback((user: string, token: string) => {
    const next = { user, token };
    writeCredentialsToUrl(next);
    setCredentials(next);
  }, []);

  if (!credentials) {
    return <AuthGate error={null} initialUser="" initialToken="" onContinue={continueAs} />;
  }

  // Remounting on identity change is deliberate: a different user must not inherit
  // the previous user's conversations or in-flight stream.
  return <ChatApp key={`${credentials.user}:${credentials.token}`} credentials={credentials} />;
}

function ChatApp({ credentials }: { credentials: Credentials }) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);

  const client = useMemo(
    () =>
      new ApiClient({
        headers: () => ({ "x-dev-token": credentials.token, "x-user-id": credentials.user }),
        onUnauthorized: () => setRejected("That token was rejected by the server."),
      }),
    [credentials],
  );

  // Confirm the credentials before rendering the chat, so a wrong token shows the
  // sign-in screen instead of an empty conversation list.
  useEffect(() => {
    let cancelled = false;
    client
      .me()
      .then((who) => {
        if (!cancelled) setIdentity(who);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setRejected(
          error instanceof ApiError && error.status === 401
            ? "That user and token do not match. Ask for your own link."
            : "Could not reach the server.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  if (rejected) {
    return (
      <AuthGate
        error={rejected}
        initialUser={credentials.user}
        initialToken=""
        onContinue={(user, token) => {
          const params = new URLSearchParams(window.location.search);
          params.set("user", user);
          params.set("token", token);
          window.location.replace(`?${params.toString()}`);
        }}
      />
    );
  }

  if (!identity) {
    return <div className="boot">Connecting…</div>;
  }

  return <Chat identity={identity} client={client} />;
}

function Chat({ identity, client }: { identity: Identity; client: ApiClient }) {
  // Built once here, not inside the panel: the poll loop must survive a switch to
  // the chat tab and back, otherwise returning to the view would restart a poll
  // for a job that is already being followed.
  const ingest = useIngest({ client });
  // The stack list comes FROM the agent: this server holds no registry of them, and
  // a stack the picker offered but the agent could not reach would produce calls the
  // service rejects. So the chat's tool result feeds the picker, and the ordering is
  // deliberate — `ingest` must exist before the hook that reports into it.
  const chat = useChat({
    client,
    onToolResult: (_tool, text, isError) => ingest.observeStacks(text, isError),
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [view, setView] = useState<"chat" | "jobs">("chat");

  if (view === "jobs") {
    return (
      <IngestJobsPanel ingest={ingest} onClose={() => setView("chat")} />
    );
  }

  return (
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
        loadingThread={chat.loadingThread}
        onSend={(text) => void chat.send(text)}
        onRetry={chat.retry}
        onStop={chat.stop}
        onOpenSidebar={() => setSidebarOpen(true)}
      />
    </div>
  );
}
