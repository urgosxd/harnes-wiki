import type { ChatFrame } from "../pi/events.ts";

/**
 * Bridges push-style hooks to an async iterator.
 *
 * The turn pushes frames as they happen; the SSE writer awaits them. Without a
 * queue in the middle the only options are buffering everything (which turns live
 * streaming into a replay at the end) or losing frames.
 */
export class FrameQueue {
  private readonly buffer: ChatFrame[] = [];
  private resolveNext: (() => void) | undefined;
  private closed = false;

  push(frame: ChatFrame): void {
    if (this.closed) return;
    this.buffer.push(frame);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const resolve = this.resolveNext;
    this.resolveNext = undefined;
    resolve?.();
  }

  /** Yields frames as they arrive, and ends after close() drains the buffer. */
  async *drain(): AsyncIterable<ChatFrame> {
    for (;;) {
      while (this.buffer.length > 0) {
        yield this.buffer.shift()!;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.resolveNext = resolve;
      });
    }
  }
}
