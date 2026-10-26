import type { Conversation } from "../lib/api.ts";

export interface SidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  loading: boolean;
  error: string | null;
  open: boolean;
  /** Shown at the bottom so a user can tell which account they are in. */
  user: string;
  onSelect(id: string): void;
  onNew(): void;
  onDelete(id: string): void;
  onClose(): void;
}

export function Sidebar({
  conversations,
  activeId,
  loading,
  error,
  open,
  user,
  onSelect,
  onNew,
  onDelete,
  onClose,
}: SidebarProps) {
  return (
    <>
      {/* The backdrop only exists on small screens, where the sidebar overlays. */}
      {open && <div className="sidebar-backdrop" onClick={onClose} aria-hidden="true" />}
      <aside className={`sidebar${open ? " sidebar--open" : ""}`} aria-label="Conversations">
        <div className="sidebar__header">
          <button type="button" className="button button--primary" onClick={onNew}>
            New chat
          </button>
        </div>

        {error && (
          <p className="sidebar__error" role="alert">
            {error}
          </p>
        )}

        {loading ? (
          <p className="sidebar__hint">Loading…</p>
        ) : conversations.length === 0 ? (
          <p className="sidebar__hint">No conversations yet.</p>
        ) : (
          <nav className="sidebar__list">
            {conversations.map((conversation) => (
              <div
                key={conversation.id}
                className={`sidebar__row${conversation.id === activeId ? " sidebar__row--active" : ""}`}
              >
                <button
                  type="button"
                  className="sidebar__item"
                  onClick={() => onSelect(conversation.id)}
                  title={conversation.title ?? "Untitled"}
                >
                  {conversation.title ?? "Untitled"}
                </button>
                <button
                  type="button"
                  className="sidebar__delete"
                  aria-label={`Delete ${conversation.title ?? "conversation"}`}
                  onClick={() => onDelete(conversation.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </nav>
        )}

        <footer className="sidebar__footer">
          <span className="sidebar__user" title={`Signed in as ${user}`}>
            {user}
          </span>
        </footer>
      </aside>
    </>
  );
}
