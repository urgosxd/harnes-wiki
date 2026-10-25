import { useMemo, useState } from "react";
import { ApiClient } from "./lib/api.ts";
import { useChat } from "./lib/use-chat.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { ChatWindow } from "./components/ChatWindow.tsx";

/**
 * Development identity.
 *
 * Real authentication is not implemented yet: the server refuses everything
 * without a token. These values come from the page's query string so a developer
 * can switch users (`?token=dev&user=alice`), and they are only a development
 * convenience, not an authentication scheme.
 */
function devHeaders(): Record<string, string> {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token") ?? "";
  const user = params.get("user") ?? "anonymous";
  return { "x-dev-token": token, "x-user-id": user };
}

export function App() {
  // The client is built once: rebuilding it per render would recreate the fetch
  // closures that the streaming loop depends on.
  const client = useMemo(() => new ApiClient({ headers: devHeaders }), []);
  const chat = useChat({ client });
  const [sidebarOpen, setSidebarOpen] = useState(false);

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
