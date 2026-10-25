import { useCallback, useMemo, useState } from "react";
import { ApiClient } from "./lib/api.ts";
import { useChat } from "./lib/use-chat.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { ChatWindow } from "./components/ChatWindow.tsx";
import { AuthGate } from "./components/AuthGate.tsx";

/**
 * Development identity, carried in the URL.
 *
 * Real authentication is not implemented: the server refuses anonymous requests,
 * which is the intended failing-closed behaviour. Until then the identity is two
 * query parameters (`?user=alice&token=dev`) so a reload keeps working and a link
 * can be shared. Anyone with the token can claim any name, so this is a
 * development convenience and nothing more.
 */
interface Identity {
  user: string;
  token: string;
}

function identityFromUrl(): Identity | null {
  const params = new URLSearchParams(window.location.search);
  const user = params.get("user")?.trim();
  const token = params.get("token")?.trim();
  if (!user || !token) return null;
  return { user, token };
}

function writeIdentityToUrl(identity: Identity): void {
  const params = new URLSearchParams(window.location.search);
  params.set("user", identity.user);
  params.set("token", identity.token);
  window.history.replaceState(null, "", `?${params.toString()}`);
}

export function App() {
  const [identity, setIdentity] = useState<Identity | null>(identityFromUrl);

  const continueAs = useCallback((user: string, token: string) => {
    const next = { user, token };
    writeIdentityToUrl(next);
    setIdentity(next);
  }, []);

  if (!identity) {
    return (
      <AuthGate
        error={null}
        initialUser=""
        initialToken=""
        onContinue={continueAs}
      />
    );
  }

  // Remounting on identity change is deliberate: a different user must not inherit
  // the previous user's loaded conversations or in-flight stream.
  return <ChatApp key={`${identity.user}:${identity.token}`} identity={identity} />;
}

function ChatApp({ identity }: { identity: Identity }) {
  const [rejected, setRejected] = useState(false);

  const client = useMemo(
    () =>
      new ApiClient({
        headers: () => ({ "x-dev-token": identity.token, "x-user-id": identity.user }),
        // A 401 means the token is wrong, not that the network hiccuped. Surface it
        // as a sign-in prompt instead of an empty chat window.
        onUnauthorized: () => setRejected(true),
      }),
    [identity],
  );

  const chat = useChat({ client });
  const [sidebarOpen, setSidebarOpen] = useState(false);

  if (rejected || chat.listError?.includes("session expired")) {
    return (
      <AuthGate
        error="That token was rejected by the server."
        initialUser={identity.user}
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

  return (
    <div className="app">
      <Sidebar
        conversations={chat.conversations}
        activeId={chat.activeId}
        loading={chat.loadingList}
        error={chat.listError}
        open={sidebarOpen}
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
