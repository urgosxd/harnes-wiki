import { useEffect, useMemo, useState } from "react";
import { ApiClient, ApiError, type Identity } from "./lib/api.ts";
import { authHeaders, parseCredentials, type Credentials } from "./lib/credentials.ts";
import { useChat } from "./lib/use-chat.ts";
import { useIngest } from "./lib/use-ingest.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { ChatWindow } from "./components/ChatWindow.tsx";
import { IngestJobsPanel } from "./components/IngestJobsPanel.tsx";

/**
 * The link IS the credentials: `?token=...`, optionally `&user=alice`.
 *
 * There is deliberately no sign-in screen. A token is the only credential this
 * product has, so a form could ask for nothing the link does not already carry: it
 * would be a prompt for a secret the person does not possess, and it used to
 * prefill the literal "dev" left over from the shared-token scheme.
 *
 * A link with no token therefore gets an explanation and nothing to type, and a
 * rejected token gets the same explanation instead of a retry form that cannot
 * succeed. Both paths say how to obtain a working link.
 */
export function App() {
  // Read once, at mount. The link is the identity; there is nothing to type and no
  // state that a later edit could contradict.
  const [credentials] = useState<Credentials | null>(() =>
    parseCredentials(window.location.search),
  );

  if (!credentials) return <MissingInviteLink problem="no-link" />;

  // Remounting on identity change is deliberate: a different user must not inherit
  // the previous user's conversations or in-flight stream.
  return <InviteSession key={credentials.token} credentials={credentials} />;
}

/** Why no usable identity is on screen, so the message can be specific. */
type InviteProblem = "no-link" | "rejected" | "unreachable";

/**
 * The only screen shown without a working identity.
 *
 * It is a dead end on purpose. Every field a form could offer would ask for the
 * token that the link already carries, so the useful content is what happened and
 * how to get a link that works. Nothing here accepts input.
 */
function MissingInviteLink({ problem }: { problem: InviteProblem }) {
  const { title, body } =
    problem === "no-link"
      ? {
          title: "This page needs your link",
          body:
            "Access is carried by the link you were given, which includes a personal " +
            "token. Open that link, or ask for a new one.",
        }
      : problem === "rejected"
        ? {
            title: "This link is no longer valid",
            body:
              "The token in this link was rejected. It may have been replaced or " +
              "removed. Ask for a new link.",
          }
        : {
            title: "Cannot reach the server",
            body: "The server did not answer. Try again in a moment.",
          };

  return (
    <div className="gate">
      <div className="gate__card">
        <h1 className="gate__title">{title}</h1>
        <p className="gate__hint">{body}</p>
      </div>
    </div>
  );
}

function InviteSession({ credentials }: { credentials: Credentials }) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [rejected, setRejected] = useState<InviteProblem | null>(null);

  const client = useMemo(
    () =>
      new ApiClient({
        // The token alone is a complete identity: `x-user-id` is sent only when the
        // link named a user, because a blank value is refused by the server.
        headers: () => authHeaders(credentials),
        onUnauthorized: () => setRejected("rejected"),
      }),
    [credentials],
  );

  // Confirm the link before rendering the chat, so a rejected token explains itself
  // instead of showing an empty conversation list that looks like lost data.
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
          error instanceof ApiError && error.status === 401 ? "rejected" : "unreachable",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  if (rejected) return <MissingInviteLink problem={rejected} />;

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
