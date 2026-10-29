import { test } from "node:test";
import assert from "node:assert/strict";
import { NEVER_REVEAL, SYSTEM_PROMPT } from "../src/pi/system-prompt.ts";

/**
 * The prompt is a contract with the model, and it had a contradiction that cost
 * exactly the answer a user is most entitled to: asked what it could do, the model
 * refused to name its tools, then named all three in prose.
 */
test("the prompt does not forbid naming a capability the user can invoke", () => {
  // The exact prohibition that caused the failure. A tool NAME is the answer to
  // "what can you do", not a secret; only credentials and implementation are.
  assert.doesNotMatch(SYSTEM_PROMPT, /never reveal tool names/i);
});

test("the prompt still forbids the things that are genuinely private", () => {
  for (const forbidden of NEVER_REVEAL) {
    const word = forbidden.split(" ")[0] ?? forbidden;
    assert.match(
      SYSTEM_PROMPT,
      new RegExp(word, "i"),
      `the prompt should forbid revealing ${forbidden}`,
    );
  }
});

test("the prompt tells the model to answer concretely rather than abstractly", () => {
  // The earlier wording was "describe your capabilities in plain language", which
  // invited a description INSTEAD of an answer. Concrete means: say what you can do,
  // and use the tool rather than paraphrasing it.
  assert.match(SYSTEM_PROMPT, /answer directly and concretely/i);
  assert.match(SYSTEM_PROMPT, /use your tools/i);
});
