import { test } from "node:test";
import assert from "node:assert/strict";
import { deprecatedDefaultStack, warnDeprecatedDefaultStack } from "../scripts/provision-mcp.mjs";

/**
 * WHY THESE EXIST
 *
 * `MCP_DEFAULT_STACK_ID` used to be REQUIRED here, on purpose: omitting it made every
 * agent call inherit whatever Stack the remote host happened to be bound to, and that
 * binding moved under us once (2026-10-28: an empty Stack, and the agent truthfully
 * told the user their wiki had 0 pages).
 *
 * The Stack now travels with the request instead, so this variable is neither read nor
 * written any more. Two failures are possible and both are pinned:
 *
 *  1. Making it required again would refuse to provision anyone who has not set a
 *     variable that no longer does anything.
 *  2. Silence would leave operators believing it still scopes their reads. Ignoring a
 *     value without saying so is the worse of the two: it looks like it worked.
 *
 * So: absence provisions silently, presence warns exactly once, and neither path
 * fails. Nothing here writes a Stack to storage — the stored column is tolerated and
 * left alone.
 */

test("absent variable provisions without failing and without a warning", () => {
  const lines: string[] = [];
  const value = warnDeprecatedDefaultStack({}, (line) => lines.push(line));
  assert.equal(value, null, "an unset variable must not produce a value");
  assert.deepEqual(lines, [], "there is nothing to warn about when nothing was set");
});

test("a set variable is ignored, and says so exactly once", () => {
  const lines: string[] = [];
  const value = warnDeprecatedDefaultStack(
    { MCP_DEFAULT_STACK_ID: "b8b8e801-b423-4a32-ab0b-e1ea2d82ead8" },
    (line) => lines.push(line),
  );
  // Returned only so the warning can be specific; nothing consumes it as a Stack.
  assert.equal(value, "b8b8e801-b423-4a32-ab0b-e1ea2d82ead8");
  assert.equal(lines.length, 1, "one warning per run, not one per user");
  assert.match(lines[0] ?? "", /deprecated/i);
  assert.match(lines[0] ?? "", /ignored/i);
  // The message must not imply the value still scopes anything.
  assert.doesNotMatch(lines[0] ?? "", /required/i);
});

test("a blank variable is the same as an absent one", () => {
  const lines: string[] = [];
  assert.equal(warnDeprecatedDefaultStack({ MCP_DEFAULT_STACK_ID: "   " }, (l) => lines.push(l)), null);
  assert.deepEqual(lines, [], "whitespace is not a value worth warning about");
});

test("the parser trims, so a copied id is not a different one", () => {
  assert.equal(
    deprecatedDefaultStack({ MCP_DEFAULT_STACK_ID: "  abc  " }),
    "abc",
  );
});
