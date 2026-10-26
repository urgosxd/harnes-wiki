import type { ActivityItem } from "../lib/chat-reducer.ts";

export interface ActivityListProps {
  items: ActivityItem[];
  /** True while the turn runs: an empty list still needs a working indicator. */
  streaming: boolean;
}

/**
 * What the assistant is doing, shown above its answer.
 *
 * The user asked for exactly this: while the model thinks, and when it uses a tool
 * or reads a skill, the window should say so instead of showing a static screen and
 * then a finished answer.
 *
 * Rules that keep it honest:
 *  - Nothing is invented. With no reported activity the component shows a generic
 *    working indicator rather than guessing which step is happening.
 *  - Reasoning is one line, not the model's deliberation: the answer is what the
 *    user asked for.
 *  - Tool names never appear; the server sends a readable label.
 *  - Finished steps stay visible after the turn, so the user can see what was done.
 */
export function ActivityList({ items, streaming }: ActivityListProps) {
  const nothingReported = items.length === 0;
  if (!streaming && nothingReported) return null;

  return (
    <section className="activity" aria-live="polite" aria-label="Assistant activity">
      {nothingReported ? (
        <div className="activity__row activity__row--working">
          <span className="spinner" aria-hidden="true" />
          <span className="activity__label">Working…</span>
        </div>
      ) : (
        items.map((item) => (
          <div
            key={item.id}
            className={`activity__row${item.failed ? " activity__row--failed" : ""}`}
            data-kind={item.kind}
          >
            {item.done ? (
              <span className="activity__icon" aria-hidden="true">
                {item.failed ? "✕" : "✓"}
              </span>
            ) : (
              <span className="spinner" aria-hidden="true" />
            )}
            <span className="activity__label">{item.label}</span>
          </div>
        ))
      )}
    </section>
  );
}
