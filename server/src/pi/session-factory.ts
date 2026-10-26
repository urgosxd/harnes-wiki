import {
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { TenantRuntime } from "./tenant-runtime.ts";
import { skillsInOutput } from "./activity.ts";

/** Ledger of persisted entries for one conversation. The only storage contract the
 *  agent needs: read all entries, append new ones. */
export interface EntryStore {
  read(conversationId: string): Promise<SessionEntry[]>;
  append(conversationId: string, entries: readonly SessionEntry[]): Promise<void>;
}

/** Outcome of one turn, derived from the persisted assistant message, never from
 *  the fact that prompt() resolved. */
export type RunOutcome = "ok" | "error" | "aborted" | "length" | "toolUse" | "deferred";

export interface TurnResult {
  outcome: RunOutcome;
  /** Text the assistant produced for this turn. */
  text: string;
  /** Provider error message when outcome is "error". */
  errorMessage: string | undefined;
  /** Entries appended by this turn, in order. */
  appended: readonly SessionEntry[];
  usage: TurnUsage | undefined;
  /** Wall-clock duration of the turn. */
  durationMs: number;
}

export interface TurnUsage {
  input: number;
  output: number;
  totalTokens: number;
  costTotal: number;
}

export interface TurnHooks {
  /** Called for every streamed text chunk. */
  onTextDelta?(delta: string): void;
  /** The model's reasoning, when the provider exposes it. */
  onThinkingDelta?(delta: string): void;
  /** Called when the agent starts executing a tool. */
  onToolStart?(toolName: string): void;
  /** Called when a tool finishes. */
  onToolEnd?(toolName: string, isError: boolean): void;
  /** Called once per skill the model consulted during this turn. */
  onSkillUsed?(name: string): void;
}

export const SESSION_HEADER_VERSION = 3;

/**
 * Run one turn in a fresh Pi session rebuilt from the stored transcript.
 *
 * A session is never kept alive between turns. The SDK keeps entries flat during a
 * turn and writes its session file only after the first assistant message, so a
 * crash mid-turn would lose the turn; rebuilding from the store is what makes
 * history survive a restart.
 */
export async function runTurn(options: {
  runtime: TenantRuntime;
  store: EntryStore;
  conversationId: string;
  message: string;
  workspaceDir: string;
  agentDir: string;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  hooks?: TurnHooks;
}): Promise<TurnResult> {
  const { runtime, store, conversationId, message, workspaceDir, agentDir, hooks } = options;

  const before = await store.read(conversationId);
  const sessionManager = SessionManager.inMemory(
    workspaceDir,
    { id: conversationId },
    before,
  );

  const { session } = await createAgentSession({
    cwd: workspaceDir,
    agentDir,
    modelRuntime: runtime.modelRuntime,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    resourceLoader: runtime.resourceLoader,
    settingsManager: runtime.settingsManager,
    sessionManager,
    // The coding tools the runtime allows are supplied explicitly, already confined
    // to the workspace; the SDK's own defaults are suppressed so nothing arrives
    // that the runtime did not choose.
    noTools: "builtin",
    customTools: [...(runtime.builtinTools as never[]), ...runtime.customTools],
    tools: runtime.toolNames,
  });

  // Without this the tools never register and the model claims it cannot see them.
  await session.bindExtensions({
    mode: "print",
    commandContextActions: {
      waitForIdle: () => session.waitForIdle(),
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: async () => ({ cancelled: true }),
      switchSession: async () => ({ cancelled: true }),
      reload: async () => {
        await session.reload();
      },
    },
    onError: () => {
      // Extension errors must never abort a user turn; they surface as tool errors.
    },
  });

  let streamed = "";
  const reportedSkills = new Set<string>();
  const startedAt = Date.now();

  const settled = new Promise<void>((resolve) => {
    session.subscribe((event) => {
      switch (event.type) {
        case "message_update": {
          const assistantEvent = event.assistantMessageEvent;
          if (assistantEvent.type === "text_delta") {
            streamed += assistantEvent.delta;
            hooks?.onTextDelta?.(assistantEvent.delta);
            // A skill's content can arrive inside the text stream; report the name
            // once so the client can show which documentation was consulted.
            for (const skill of skillsInOutput(assistantEvent.delta)) {
              if (!reportedSkills.has(skill)) {
                reportedSkills.add(skill);
                hooks?.onSkillUsed?.(skill);
              }
            }
          } else if (assistantEvent.type === "thinking_delta") {
            hooks?.onThinkingDelta?.(assistantEvent.delta);
          }
          break;
        }
        case "tool_execution_start":
          hooks?.onToolStart?.(event.toolName);
          break;
        case "tool_execution_end":
          hooks?.onToolEnd?.(event.toolName, event.isError);
          break;
        case "agent_settled":
          // The run is over only when Pi will not continue on its own. agent_end
          // can still be followed by retries or queued work.
          resolve();
          break;
        default:
          break;
      }
    });
  });

  try {
    await session.prompt(message);
    await settled;
  } finally {
    // Read the transcript before disposing: the in-memory manager is the only
    // record of what this turn appended.
    const after = sessionManager.getEntries();
    const appended = after.slice(before.length);
    session.dispose();

    if (appended.length > 0) {
      await store.append(conversationId, appended);
    }

    const lastAssistant = [...sessionManager.getEntries()]
      .reverse()
      .find(
        (entry): entry is Extract<SessionEntry, { type: "message" }> =>
          entry.type === "message" && entry.message.role === "assistant",
      );

    const outcome = toOutcome(lastAssistant?.message);
    const usage = toUsage(lastAssistant?.message);
    const errorMessage =
      lastAssistant?.message.role === "assistant" ? lastAssistant.message.errorMessage : undefined;

    return {
      outcome,
      text: streamed || lastAssistantText(lastAssistant?.message) || "",
      errorMessage,
      appended,
      usage,
      durationMs: Date.now() - startedAt,
    };
  }
}

function toOutcome(message: unknown): RunOutcome {
  if (!message || typeof message !== "object") return "error";
  const stopReason = (message as { stopReason?: string }).stopReason;
  switch (stopReason) {
    case "stop":
      return "ok";
    case "aborted":
      return "aborted";
    case "length":
      return "length";
    case "toolUse":
      return "toolUse";
    case "deferred":
      return "deferred";
    default:
      // "error", "pending" and anything unknown are failures from the product's
      // point of view: the user did not get an answer.
      return "error";
  }
}

function toUsage(message: unknown): TurnUsage | undefined {
  if (!message || typeof message !== "object") return undefined;
  const usage = (message as { usage?: { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } } }).usage;
  if (!usage) return undefined;
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    costTotal: usage.cost?.total ?? 0,
  };
}

function lastAssistantText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return typeof content === "string" ? content : undefined;
  const text = content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null && (block as { type?: string }).type === "text",
    )
    .map((block) => block.text)
    .join("");
  return text.length ? text : undefined;
}

/** An in-memory entry store, for tests and for the vertical slice before Postgres. */
export class MemoryEntryStore implements EntryStore {
  private readonly byConversation = new Map<string, SessionEntry[]>();

  async read(conversationId: string): Promise<SessionEntry[]> {
    return [...(this.byConversation.get(conversationId) ?? [])];
  }

  async append(conversationId: string, entries: readonly SessionEntry[]): Promise<void> {
    const current = this.byConversation.get(conversationId) ?? [];
    this.byConversation.set(conversationId, [...current, ...entries]);
  }

  count(conversationId: string): number {
    return this.byConversation.get(conversationId)?.length ?? 0;
  }

  /** Serialize to JSON so a test can simulate a process restart. */
  dump(conversationId: string): string {
    return JSON.stringify(this.byConversation.get(conversationId) ?? []);
  }

  static restore(conversationId: string, json: string): MemoryEntryStore {
    const store = new MemoryEntryStore();
    store.byConversation.set(conversationId, JSON.parse(json) as SessionEntry[]);
    return store;
  }
}

/** Read the session display name, which Pi persists as a session_info entry. */
export function sessionName(session: AgentSession): string | undefined {
  return session.sessionManager.getSessionName();
}
