import { describe, it, expect } from "vitest";
import { parseStackId } from "./tenant.ts";

/**
 * The tenant is the Stack named in the link, and this is the whole of what the
 * browser decides about it: is there a value, and what is it.
 *
 * Two rules are pinned here and nothing else:
 *
 *  1. Absence blocks. No default, no remembered value, no fallback.
 *  2. Shape only. Whether the id exists, or even looks like a UUID, is the
 *     service's answer to give — the browser must not pre-empt it.
 */
describe("parseStackId", () => {
  it("takes the stack id from the link, next to the user", () => {
    expect(parseStackId("?user=alice&stackId=0f8b1e42")).toEqual({
      ok: true,
      stackId: "0f8b1e42",
    });
  });

  it("blocks a link that names no stack, whatever else it carries", () => {
    // Every one of these is the same fact: no tenant. A value invented here would
    // be a read against somebody else's Stack.
    expect(parseStackId("")).toEqual({ ok: false, problem: "missing" });
    expect(parseStackId("?user=alice")).toEqual({ ok: false, problem: "missing" });
    expect(parseStackId("?user=alice&stackId=")).toEqual({ ok: false, problem: "missing" });
  });

  it("treats whitespace as absent, not as a Stack called ' '", () => {
    expect(parseStackId("?stackId=%20%20")).toEqual({ ok: false, problem: "missing" });
    expect(parseStackId("?stackId=%09%0A")).toEqual({ ok: false, problem: "missing" });
  });

  it("trims what a copy-paste adds, because a stray space is a different id", () => {
    expect(parseStackId("?stackId=%20%200f8b1e42%0A")).toEqual({
      ok: true,
      stackId: "0f8b1e42",
    });
  });

  it("does not judge the id beyond emptiness", () => {
    // The server/upstream owns the UUID rule and answers `400 invalid_stack_id`.
    // A second, stricter opinion here would refuse values the service accepts and
    // would hide the answer the user needs to see.
    expect(parseStackId("?stackId=not-a-uuid")).toEqual({ ok: true, stackId: "not-a-uuid" });
  });
});
