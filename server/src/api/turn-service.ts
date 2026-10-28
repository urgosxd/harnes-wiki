import { randomUUID } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ChatFrame, RunOutcomeName } from "../pi/events.ts";
import { closingFrames } from "../pi/events.ts";
import { FrameQueue } from "./frame-queue.ts";
import { toolLabel } from "../pi/activity.ts";
import type { TurnResult } from "../pi/session-factory.ts";
import { runTurn } from "../pi/session-factory.ts";
import type { TenantRuntime } from "../pi/tenant-runtime.ts";
import type { ConversationStore, RunRecord } from "../db/conversation-store.ts";

export type StartTurnOutcome =
  | { kind: "started"; runId: string; frames: AsyncIterable<ChatFrame> }
  | { kind: "replayed"; run: RunRecord }
  | { kind: "busy"; running: RunRecord | undefined }
  | { kind: "not_found" };

export interface TurnServiceOptions {
  store: ConversationStore;
  runtimeFor: (userId: string) => Promise<TenantRuntime>;
  workspaceDir: string;
  agentDir: string;
  modelFor: (runtime: TenantRuntime) => Model<never>;
  thinkingLevel: ThinkingLevel;
}

/**
 * One turn, from "start it" to "frames the client can paint".
 *
 * The run row is created before any model work, so the busy check happens in the
 * database rather than in a process-local mutex. The transcript append happens in
 * the turn itself; if the process dies mid-turn the run stays 'running' and is
 * swept on the next boot, which frees the conversation again.
 */
export class TurnService {
  private readonly options: TurnServiceOptions;

  constructor(options: TurnServiceOptions) {
    this.options = options;
  }

  async start(input: {
    userId: string;
    conversationId: string;
    message: string;
    idempotencyKey: string;
  }): Promise<StartTurnOutcome> {
    const { store } = this.options;

    const conversation = await store.findOwned(input.conversationId, input.userId);
    if (!conversation) return { kind: "not_found" };

    const started = await store.startRun({
      id: randomUUID(),
      conversationId: conversation.id,
      idempotencyKey: input.idempotencyKey,
    });

    if (started.status === "busy") return { kind: "busy", running: started.running };
    if (started.status === "replay") return { kind: "replayed", run: started.run };

    const runId = started.run.id;
    return {
      kind: "started",
      runId,
      frames: this.stream({ ...input, runId }),
    };
  }

  /**
   * Run the turn in the background and hand back frames as they happen.
   *
   * The turn is started, not awaited: an async generator that only yielded after
   * runTurn resolved would deliver every delta at once, which is the replay
   * behaviour the streaming test exists to catch.
   */
  private stream(input: {
    userId: string;
    conversationId: string;
    message: string;
    runId: string;
  }): AsyncIterable<ChatFrame> {
    const queue = new FrameQueue();
    void this.execute(input, queue);
    return queue.drain();
  }

  private async execute(
    input: {
      userId: string;
      conversationId: string;
      message: string;
      runId: string;
    },
    queue: FrameQueue,
  ): Promise<void> {
    const { store, runtimeFor, workspaceDir, agentDir, modelFor, thinkingLevel } = this.options;

    queue.push({ type: "run_started", runId: input.runId });

    let runtime: TenantRuntime;
    try {
      runtime = await runtimeFor(input.userId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await store.finishRun(input.runId, { status: "error", errorMessage: message });
      queue.push({ type: "run_failed", outcome: "error", message });
      queue.close();
      return;
    }

    let result: TurnResult;
    try {
      result = await runTurn({
        runtime,
        store,
        conversationId: input.conversationId,
        message: input.message,
        workspaceDir,
        agentDir,
        model: modelFor(runtime),
        thinkingLevel,
        hooks: {
          onTextDelta: (delta) => queue.push({ type: "text_delta", delta }),
          onThinkingDelta: (delta) => queue.push({ type: "thinking_delta", delta }),
          onSkillUsed: (name) => queue.push({ type: "skill_used", name }),
          onToolStart: (tool) =>
            queue.push({ type: "tool_started", tool, label: toolLabel(tool) }),
          onToolEnd: (tool, isError) =>
            queue.push({ type: "tool_finished", tool, label: toolLabel(tool), isError }),
          onToolResult: (tool, text, isError) =>
            queue.push({ type: "tool_result", tool, text, isError }),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await store.finishRun(input.runId, { status: "error", errorMessage: message });
      queue.push({ type: "run_failed", outcome: "error", message });
      queue.close();
      return;
    }

    try {
      await store.finishRun(input.runId, {
        status: toRunStatus(result.outcome),
        stopReason: result.outcome,
        errorMessage: result.errorMessage,
        totalTokens: result.usage?.totalTokens,
        costTotal: result.usage?.costTotal,
      });
    } finally {
      for (const frame of closingFrames({
        outcome: result.outcome,
        errorMessage: result.errorMessage,
        usage: result.usage,
      })) {
        queue.push(frame);
      }
      queue.close();
    }
  }
}

function toRunStatus(outcome: RunOutcomeName): RunRecord["status"] {
  switch (outcome) {
    case "ok":
      return "ok";
    case "aborted":
      return "aborted";
    case "length":
      return "length";
    default:
      return "error";
  }
}
