import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

/**
 * The agent-definition settings are operator-facing, and both defaults matter: an
 * operator who bind-mounts a directory gets it picked up from `.env`, and an empty
 * selection has to mean "disabled" rather than "invalid".
 *
 * The selection's strictness (a selected definition carrying keys this runtime cannot
 * honor fails the boot) is asserted here too when the rule is reachable without a
 * database; `server/src/main.ts` runs `main()` on import, so see the note below.
 */

const base: NodeJS.ProcessEnv = {
  PI_AGENT_CONFIG_MODE: "generate",
  PI_WORKSPACE_DIR: "/var/lib/chat/workspace",
  CHAT_PROVIDER: "synthetic",
  CHAT_MODEL: "syn:large:text",
  HOME: "/home/node",
};

test("agent definitions default to $HOME/.agents/agents with no selection", () => {
  const config = loadConfig({ ...base });
  assert.equal(config.agentsDir, "/home/node/.agents/agents");
  assert.equal(config.agentDefinition, "");
});

test("PI_AGENTS_DIR wins over the default and AGENT_DEFINITION is trimmed", () => {
  const config = loadConfig({
    ...base,
    PI_AGENTS_DIR: " /mnt/agents ",
    AGENT_DEFINITION: "  documentor  ",
  });
  assert.equal(config.agentsDir, "/mnt/agents");
  assert.equal(config.agentDefinition, "documentor");
});

test("a blank AGENT_DEFINITION is the disabled state, not an error", () => {
  assert.equal(loadConfig({ ...base, AGENT_DEFINITION: "   " }).agentDefinition, "");
});
