import { describe, it, expect } from "vitest";
import { SseParser, parseChatFrame } from "./sse.ts";

describe("SseParser", () => {
  it("parses one complete frame", () => {
    const parser = new SseParser();
    const frames = parser.push('data: {"type":"text_delta","delta":"hi"}\n\n');
    expect(frames).toEqual([{ event: undefined, data: '{"type":"text_delta","delta":"hi"}' }]);
  });

  it("parses several frames in one chunk", () => {
    const parser = new SseParser();
    const frames = parser.push("data: a\n\ndata: b\n\ndata: c\n\n");
    expect(frames.map((f) => f.data)).toEqual(["a", "b", "c"]);
  });

  it("holds an incomplete frame until the next chunk", () => {
    const parser = new SseParser();
    expect(parser.push("data: hel")).toEqual([]);
    expect(parser.pending).toBe("data: hel");
    expect(parser.push("lo\n\n").map((f) => f.data)).toEqual(["hello"]);
    expect(parser.pending).toBe("");
  });

  it("survives a boundary that splits the terminating blank line", () => {
    const parser = new SseParser();
    expect(parser.push("data: x\n")).toEqual([]);
    expect(parser.push("\n").map((f) => f.data)).toEqual(["x"]);
  });

  it("survives a boundary inside a JSON string", () => {
    const parser = new SseParser();
    const payload = JSON.stringify({ type: "text_delta", delta: 'a "quoted" word' });
    const split = Math.floor(payload.length / 2);
    const frames = [
      ...parser.push(`data: ${payload.slice(0, split)}`),
      ...parser.push(`${payload.slice(split)}\n\n`),
    ];
    expect(frames).toHaveLength(1);
    expect(parseChatFrame(frames[0]!.data)).toEqual({
      type: "text_delta",
      delta: 'a "quoted" word',
    });
  });

  it("accepts CRLF line endings", () => {
    const parser = new SseParser();
    const frames = parser.push("data: a\r\n\r\ndata: b\r\n\r\n");
    expect(frames.map((f) => f.data)).toEqual(["a", "b"]);
  });

  it("keeps an event name", () => {
    const parser = new SseParser();
    const [frame] = parser.push("event: delta\ndata: x\n\n");
    expect(frame).toEqual({ event: "delta", data: "x" });
  });

  it("ignores comment lines such as the connected preamble", () => {
    const parser = new SseParser();
    expect(parser.push(": connected\n\n")).toEqual([]);
  });

  it("joins multi-line data with a newline", () => {
    const parser = new SseParser();
    const [frame] = parser.push("data: line1\ndata: line2\n\n");
    expect(frame?.data).toBe("line1\nline2");
  });

  it("strips exactly one space after the colon", () => {
    const parser = new SseParser();
    const [frame] = parser.push("data:  two spaces\n\n");
    expect(frame?.data).toBe(" two spaces");
  });

  it("does not lose frames when chunks arrive byte by byte", () => {
    const parser = new SseParser();
    const wire = 'data: {"type":"run_started","runId":"r1"}\n\ndata: {"type":"text_delta","delta":"x"}\n\n';
    const collected = [];
    for (const char of wire) {
      collected.push(...parser.push(char));
    }
    expect(collected).toHaveLength(2);
    expect(parseChatFrame(collected[1]!.data)).toEqual({ type: "text_delta", delta: "x" });
  });
});

describe("parseChatFrame", () => {
  it("rejects malformed JSON instead of throwing", () => {
    expect(parseChatFrame("{not json")).toBeUndefined();
  });

  it("rejects an unknown frame type", () => {
    expect(parseChatFrame('{"type":"something_new"}')).toBeUndefined();
  });

  it("accepts each known frame", () => {
    expect(parseChatFrame('{"type":"run_started","runId":"r"}')).toBeDefined();
    expect(parseChatFrame('{"type":"text_delta","delta":"d"}')).toBeDefined();
    expect(parseChatFrame('{"type":"tool_started","tool":"t"}')).toBeDefined();
    expect(parseChatFrame('{"type":"tool_finished","tool":"t","isError":false}')).toBeDefined();
    expect(parseChatFrame('{"type":"run_finished","outcome":"ok"}')).toBeDefined();
    expect(parseChatFrame('{"type":"run_failed","outcome":"error","message":"m"}')).toBeDefined();
  });
});
