/**
 * Frames the chat client receives over SSE.
 *
 * The client never sees a Pi event. Pi's event names, message shapes and tool
 * payloads are implementation detail, and exposing them would tie the browser to a
 * Pi version. One small vocabulary is sent instead.
 */
export type ChatFrame =
  | { type: "run_started"; runId: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_started"; tool: string }
  | { type: "tool_finished"; tool: string; isError: boolean }
  | { type: "run_finished"; outcome: RunOutcomeName; usage?: FrameUsage }
  | { type: "run_failed"; outcome: RunOutcomeName; message: string }
  | { type: "error"; message: string };

export type RunOutcomeName = "ok" | "error" | "aborted" | "length" | "toolUse" | "deferred";

export interface FrameUsage {
  input: number;
  output: number;
  totalTokens: number;
  costTotal: number;
}

/** Encode one frame as an SSE record. */
export function encodeFrame(frame: ChatFrame): string {
  return `data: ${JSON.stringify(frame)}\n\n`;
}

/**
 * Encode a frame with an event name, so a client can subscribe selectively
 * without parsing every payload.
 */
export function encodeNamedFrame(name: string, frame: ChatFrame): string {
  return `event: ${name}\ndata: ${JSON.stringify(frame)}\n\n`;
}

/**
 * Map a finished turn to the frames that close the stream.
 *
 * A failed turn is not an exception at the transport level: the run happened, the
 * user needs to see why it produced nothing, and the connection must still close
 * cleanly so the client can offer a retry.
 */
export function closingFrames(result: {
  outcome: RunOutcomeName;
  errorMessage?: string | undefined;
  usage?: FrameUsage | undefined;
}): ChatFrame[] {
  if (result.outcome === "ok" || result.outcome === "length") {
    return [
      result.usage
        ? { type: "run_finished", outcome: result.outcome, usage: result.usage }
        : { type: "run_finished", outcome: result.outcome },
    ];
  }
  if (result.outcome === "aborted") {
    return [{ type: "run_finished", outcome: "aborted" }];
  }
  return [
    {
      type: "run_failed",
      outcome: result.outcome,
      message: result.errorMessage ?? "the model produced no answer",
    },
  ];
}
