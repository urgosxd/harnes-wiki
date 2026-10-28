/**
 * Server-Sent Events parsing.
 *
 * Written by hand because the failure modes matter and are easy to get wrong:
 * a chunk boundary can fall in the middle of a frame, inside a JSON string, or
 * between the two newlines that end a record. Assuming one chunk equals one frame
 * works in development and corrupts long replies.
 */

export interface SseFrame {
  event: string | undefined;
  data: string;
}

/** Incremental parser: feed it chunks, receive complete frames. */
export class SseParser {
  private buffer = "";

  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];

    for (;;) {
      const separator = findSeparator(this.buffer);
      if (!separator) break;

      const raw = this.buffer.slice(0, separator.index);
      this.buffer = this.buffer.slice(separator.index + separator.length);
      const frame = parseBlock(raw);
      if (frame) frames.push(frame);
    }

    return frames;
  }

  /** Bytes left over that never formed a complete frame. */
  get pending(): string {
    return this.buffer;
  }
}

/** A record ends with a blank line, in either newline convention. */
function findSeparator(buffer: string): { index: number; length: number } | undefined {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return undefined;
  if (lf === -1) return { index: crlf, length: 4 };
  if (crlf === -1) return { index: lf, length: 2 };
  return crlf < lf ? { index: crlf, length: 4 } : { index: lf, length: 2 };
}

function parseBlock(raw: string): SseFrame | undefined {
  let event: string | undefined;
  const dataLines: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    // Comment lines start with ':' and carry no payload.
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    // One optional space after the colon is part of the framing, not the value.
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");

    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }

  if (dataLines.length === 0) return undefined;
  return { event, data: dataLines.join("\n") };
}

export type ChatFrame =
  | { type: "run_started"; runId: string }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "skill_used"; name: string }
  | { type: "tool_started"; tool: string; label: string }
  | { type: "tool_finished"; tool: string; label: string; isError: boolean }
  /** A tool's output the caller asked for. One observation, not state. */
  | { type: "tool_result"; tool: string; text: string; isError: boolean }
  | { type: "run_finished"; outcome: string; usage?: unknown }
  | { type: "run_failed"; outcome: string; message: string }
  | { type: "error"; message: string };

/**
 * Does this look like one of our frames?
 *
 * Unknown frames are dropped rather than cast: a newer server sending a frame an
 * older client does not understand must not crash the window.
 */
export function isChatFrame(value: unknown): value is ChatFrame {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === "run_started" ||
    type === "text_delta" ||
    type === "thinking_delta" ||
    type === "skill_used" ||
    type === "tool_started" ||
    type === "tool_finished" ||
    type === "tool_result" ||
    type === "run_finished" ||
    type === "run_failed" ||
    type === "error"
  );
}

export function parseChatFrame(data: string): ChatFrame | undefined {
  try {
    const parsed: unknown = JSON.parse(data);
    return isChatFrame(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
