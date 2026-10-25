import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Database } from "./pool.ts";
import type { EntryStore } from "../pi/session-factory.ts";

export interface Conversation {
  id: string;
  userId: string;
  title: string | null;
  piSessionId: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

/**
 * Outcome of trying to start a turn.
 *
 * The three cases are distinct variants rather than a `created` boolean with an
 * optional `busy` field, so a caller cannot forget the busy case: reading `.run`
 * is a type error until the branch is handled.
 */
export type StartRunResult =
  | { status: "created"; run: RunRecord }
  /** The same idempotency key was already used: replay the original run. */
  | { status: "replay"; run: RunRecord }
  /** A different turn is already running on this conversation. */
  | { status: "busy"; running: RunRecord | undefined };

export interface RunRecord {
  id: string;
  conversationId: string;
  idempotencyKey: string;
  status: "running" | "ok" | "error" | "aborted" | "length";
  stopReason: string | null;
  errorMessage: string | null;
  totalTokens: number | null;
  costTotal: number | null;
}

interface ConversationRow {
  id: string;
  user_id: string;
  title: string | null;
  pi_session_id: string;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

interface RunRow {
  id: string;
  conversation_id: string;
  idempotency_key: string;
  status: RunRecord["status"];
  stop_reason: string | null;
  error_message: string | null;
  total_tokens: number | null;
  cost_total: string | null;
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    piSessionId: row.pi_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function toRunRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    stopReason: row.stop_reason,
    errorMessage: row.error_message,
    totalTokens: row.total_tokens,
    // numeric arrives as a string from pg; keep the conversion explicit.
    costTotal: row.cost_total === null ? null : Number(row.cost_total),
  };
}

export class ConversationStore implements EntryStore {
  // A field, not a constructor parameter property: node's strip-only TypeScript
  // support rejects `constructor(private x: T)`.
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  // ---------------------------------------------------------------------------
  // Catalog
  // ---------------------------------------------------------------------------

  async create(input: {
    id: string;
    userId: string;
    piSessionId: string;
    title?: string | null;
  }): Promise<Conversation> {
    const rows = await this.db.query<ConversationRow>(
      `INSERT INTO conversations (id, user_id, pi_session_id, title)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.id, input.userId, input.piSessionId, input.title ?? null],
    );
    return toConversation(rows[0]!);
  }

  /** Newest first, archived excluded. The sidebar query. */
  async listForUser(userId: string): Promise<Conversation[]> {
    const rows = await this.db.query<ConversationRow>(
      `SELECT * FROM conversations
        WHERE user_id = $1 AND archived_at IS NULL
        ORDER BY updated_at DESC`,
      [userId],
    );
    return rows.map(toConversation);
  }

  /**
   * Ownership is part of the lookup, not a check afterwards: a conversation that
   * belongs to someone else is indistinguishable from one that does not exist.
   */
  async findOwned(id: string, userId: string): Promise<Conversation | undefined> {
    const rows = await this.db.query<ConversationRow>(
      `SELECT * FROM conversations WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    const row = rows[0];
    return row ? toConversation(row) : undefined;
  }

  async rename(id: string, userId: string, title: string): Promise<Conversation | undefined> {
    const rows = await this.db.query<ConversationRow>(
      `UPDATE conversations SET title = $3
        WHERE id = $1 AND user_id = $2
        RETURNING *`,
      [id, userId, title],
    );
    const row = rows[0];
    return row ? toConversation(row) : undefined;
  }

  async archive(id: string, userId: string): Promise<boolean> {
    const rows = await this.db.query<{ id: string }>(
      `UPDATE conversations SET archived_at = now()
        WHERE id = $1 AND user_id = $2 AND archived_at IS NULL
        RETURNING id`,
      [id, userId],
    );
    return rows.length > 0;
  }

  async touch(id: string): Promise<void> {
    await this.db.query("UPDATE conversations SET updated_at = now() WHERE id = $1", [id]);
  }

  // ---------------------------------------------------------------------------
  // Transcript (EntryStore)
  // ---------------------------------------------------------------------------

  /** The whole transcript, in replay order. */
  async read(conversationId: string): Promise<SessionEntry[]> {
    const rows = await this.db.query<{ entry: SessionEntry }>(
      `SELECT entry FROM session_entries
        WHERE conversation_id = $1
        ORDER BY seq ASC`,
      [conversationId],
    );
    return rows.map((row) => row.entry);
  }

  /**
   * Append entries, numbering them after the highest existing seq.
   *
   * The seq is computed inside the INSERT so two appends cannot pick the same
   * number; the (conversation_id, seq) primary key rejects it if they try.
   * ON CONFLICT DO NOTHING makes a retried append harmless instead of fatal.
   */
  async append(conversationId: string, entries: readonly SessionEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.db.transaction(async (tx) => {
      let offset = 0;
      for (const entry of entries) {
        await tx.query(
          `INSERT INTO session_entries (conversation_id, seq, entry)
           SELECT $1, COALESCE(MAX(seq), 0) + $2 + 1, $3::jsonb
             FROM session_entries
            WHERE conversation_id = $1
           ON CONFLICT (conversation_id, seq) DO NOTHING`,
          [conversationId, offset, JSON.stringify(entry)],
        );
        offset += 1;
      }
      await tx.query("UPDATE conversations SET updated_at = now() WHERE id = $1", [conversationId]);
    });
  }

  async entryCount(conversationId: string): Promise<number> {
    const rows = await this.db.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM session_entries WHERE conversation_id = $1",
      [conversationId],
    );
    return Number(rows[0]?.count ?? "0");
  }

  // ---------------------------------------------------------------------------
  // Runs and idempotency
  // ---------------------------------------------------------------------------

  /**
   * Start a run, or return the existing one for this idempotency key.
   *
   * `created` is false when the key was already used, which is how a reconnecting
   * client learns it must not expect a second answer.
   *
   * A different key on a conversation that already has a running turn is refused:
   * two concurrent turns would each rebuild from the same snapshot, so the second
   * model call would not see the first user message and both would append.
   */
  async startRun(input: {
    id: string;
    conversationId: string;
    idempotencyKey: string;
  }): Promise<StartRunResult> {
    const inserted = await this.db.query<RunRow>(
      `INSERT INTO agent_runs (id, conversation_id, idempotency_key, status)
       VALUES ($1, $2, $3, 'running')
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [input.id, input.conversationId, input.idempotencyKey],
    );
    if (inserted[0]) return { status: "created", run: toRunRecord(inserted[0]) };

    const existing = await this.db.query<RunRow>(
      `SELECT * FROM agent_runs WHERE conversation_id = $1 AND idempotency_key = $2`,
      [input.conversationId, input.idempotencyKey],
    );
    // Same key: a replay, not a new turn. Hand back the original run.
    if (existing[0]) return { status: "replay", run: toRunRecord(existing[0]) };

    // Different key, and something is already running on this conversation.
    const running = await this.db.query<RunRow>(
      `SELECT * FROM agent_runs WHERE conversation_id = $1 AND status = 'running'`,
      [input.conversationId],
    );
    if (running[0]) return { status: "busy", running: toRunRecord(running[0]) };

    // The conflict came from a race that has since resolved; report it as busy
    // rather than inventing a run.
    return { status: "busy", running: undefined };
  }

  async finishRun(
    id: string,
    result: {
      status: RunRecord["status"];
      stopReason?: string | undefined;
      errorMessage?: string | undefined;
      totalTokens?: number | undefined;
      costTotal?: number | undefined;
    },
  ): Promise<void> {
    await this.db.query(
      `UPDATE agent_runs
          SET status = $2,
              stop_reason = $3,
              error_message = $4,
              total_tokens = $5,
              cost_total = $6,
              finished_at = now()
        WHERE id = $1`,
      [
        id,
        result.status,
        result.stopReason ?? null,
        result.errorMessage ?? null,
        result.totalTokens ?? null,
        result.costTotal ?? null,
      ],
    );
  }

  async findRun(id: string): Promise<RunRecord | undefined> {
    const rows = await this.db.query<RunRow>("SELECT * FROM agent_runs WHERE id = $1", [id]);
    const row = rows[0];
    return row ? toRunRecord(row) : undefined;
  }

  /** Mark runs left in "running" by a crashed process, so the UI can offer a retry. */
  async failInterruptedRuns(): Promise<number> {
    const rows = await this.db.query<{ id: string }>(
      `UPDATE agent_runs
          SET status = 'error',
              error_message = 'the server stopped before this run finished',
              finished_at = now()
        WHERE status = 'running'
        RETURNING id`,
    );
    return rows.length;
  }

  // ---------------------------------------------------------------------------
  // Per-tenant configuration
  // ---------------------------------------------------------------------------

  async listMcpServers(userId: string): Promise<
    Array<{ serverName: string; command: string; args: string[]; env: Record<string, string>; exposedTools: string[] }>
  > {
    const rows = await this.db.query<{
      server_name: string;
      command: string;
      args: string[];
      env: Record<string, string>;
      exposed_tools: string[];
    }>(
      `SELECT server_name, command, args, env, exposed_tools
         FROM tenant_mcp WHERE user_id = $1 AND enabled = true
        ORDER BY server_name`,
      [userId],
    );
    return rows.map((row) => ({
      serverName: row.server_name,
      command: row.command,
      args: row.args,
      env: row.env,
      exposedTools: row.exposed_tools,
    }));
  }

  async listScopes(userId: string): Promise<string[]> {
    const rows = await this.db.query<{ scope: string }>(
      "SELECT scope FROM tenant_scopes WHERE user_id = $1 ORDER BY scope",
      [userId],
    );
    return rows.map((row) => row.scope);
  }
}
