import { describe, it, expect } from "vitest";
import { defaultStackId, parseStacksPayload, type StackOption } from "./stacks.ts";
import { isChatFrame, parseChatFrame } from "./sse.ts";

/**
 * WHY THESE EXIST
 *
 * The picker is fed by a tool result, which is text produced by another service —
 * so every way it can be wrong is a way the picker can offer a stack that does not
 * exist. Three rules follow, and each is pinned:
 *
 *  1. A malformed payload yields NOTHING plus a reason. Never a guessed entry.
 *  2. An entry without a usable id is dropped, not defaulted: an empty id would be
 *     sent back to the service as if it were one.
 *  3. Failure and emptiness are different. The service answers `isError` for an
 *     unknown stack so they cannot be confused, and the picker keeps that apart.
 */

const payload = (stacks: unknown) => JSON.stringify({ stacks, count: (stacks as unknown[]).length });

describe("parseStacksPayload", () => {
  it("reads the stacks the tool returned", () => {
    const parsed = parseStacksPayload(
      payload([
        { id: "a", name: "Alpha", isCurrent: true },
        { id: "b", name: "Beta", isCurrent: false },
      ]),
    );
    expect(parsed.problem).toBeNull();
    expect(parsed.stacks).toEqual([
      { id: "a", name: "Alpha", isCurrent: true },
      { id: "b", name: "Beta", isCurrent: false },
    ]);
  });

  it("treats a real empty list as empty, with no problem reported", () => {
    const parsed = parseStacksPayload(payload([]));
    expect(parsed.stacks).toEqual([]);
    // Emptiness is not a failure. Saying otherwise would make a deployment with no
    // stacks look broken.
    expect(parsed.problem).toBeNull();
  });

  it("reports unreadable text instead of returning an empty list silently", () => {
    const parsed = parseStacksPayload("this is not json");
    expect(parsed.stacks).toEqual([]);
    expect(parsed.problem).toMatch(/could not be read/);
  });

  it("reports a payload with no stack array", () => {
    expect(parseStacksPayload(JSON.stringify({ count: 0 })).problem).toMatch(/could not be read/);
    expect(parseStacksPayload(JSON.stringify({ stacks: "nope" })).problem).toMatch(/could not be read/);
  });

  it("drops an entry without a usable id rather than defaulting one", () => {
    const parsed = parseStacksPayload(
      payload([{ id: "", name: "Empty id" }, { name: "No id at all" }, { id: "ok", name: "Fine" }]),
    );
    // An empty id sent back to the service would be a real call for a stack that is
    // not real, so the entry is dropped and the valid ones survive.
    expect(parsed.stacks.map((s) => s.id)).toEqual(["ok"]);
  });

  it("falls back to the id when a stack has no name, instead of inventing a label", () => {
    const parsed = parseStacksPayload(payload([{ id: "abcdef", isCurrent: false }]));
    expect(parsed.stacks[0]?.name).toBe("abcdef");
  });

  it("treats only a literal true as current", () => {
    const parsed = parseStacksPayload(
      payload([{ id: "a", name: "A", isCurrent: "yes" }, { id: "b", name: "B", isCurrent: 1 }]),
    );
    // A truthy non-boolean must not mark a stack as bound; the field decides a
    // default selection the user did not make.
    expect(parsed.stacks.every((s) => s.isCurrent === false)).toBe(true);
  });
});

describe("defaultStackId", () => {
  const stack = (id: string, isCurrent = false): StackOption => ({ id, name: id, isCurrent });

  it("preselects the bound stack", () => {
    expect(defaultStackId([stack("a"), stack("b", true)])).toBe("b");
  });

  it("preselects nothing when no stack is marked bound", () => {
    // Picking the first entry would silently choose a stack the user never chose.
    expect(defaultStackId([stack("a"), stack("b")])).toBeNull();
  });

  it("preselects nothing when the list is empty", () => {
    expect(defaultStackId([])).toBeNull();
  });
});


/**
 * The frame itself.
 *
 * `tool_result` is the one frame this feature added, and the wire is where it can
 * silently disappear: a client that does not recognise the type drops the frame
 * without erroring, so the picker would stay empty with nothing to explain it.
 */
describe("the tool_result frame", () => {
  it("is recognised, so the payload is not dropped as unknown", () => {
    const frame = {
      type: "tool_result",
      tool: "list_stacks",
      text: '{"stacks":[],"count":0}',
      isError: false,
    };
    expect(isChatFrame(frame)).toBe(true);
  });

  it("survives a round trip through the parser", () => {
    const frame = { type: "tool_result", tool: "list_stacks", text: "{}", isError: true };
    expect(parseChatFrame(JSON.stringify(frame))).toEqual(frame);
  });

  it("still rejects a frame it does not understand", () => {
    // The reason the allowlist exists: a newer server must not crash an older client.
    expect(isChatFrame({ type: "something_new" })).toBe(false);
  });
});
