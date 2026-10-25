import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, ConfigError } from "../src/config.ts";

const base = {
  PI_AGENT_DIR: "/pi/agent",
  PI_WORKSPACE_DIR: "/var/lib/chat/workspace",
  CHAT_PROVIDER: "synthetic",
  CHAT_MODEL: "syn:large:text",
} satisfies NodeJS.ProcessEnv;

test("loads a valid configuration", () => {
  const cfg = loadConfig({ ...base });
  assert.equal(cfg.agentDir, "/pi/agent");
  assert.equal(cfg.workspaceDir, "/var/lib/chat/workspace");
  assert.equal(cfg.provider, "synthetic");
  assert.equal(cfg.modelId, "syn:large:text");
  assert.equal(cfg.thinkingLevel, "medium");
  assert.equal(cfg.databaseUrl, undefined);
});

test("rejects a missing required value", () => {
  const { CHAT_MODEL: _omitted, ...withoutModel } = base;
  assert.throws(() => loadConfig(withoutModel), (e: unknown) => {
    assert.ok(e instanceof ConfigError);
    assert.match(e.message, /CHAT_MODEL is required/);
    return true;
  });
});

test("rejects an unknown thinking level", () => {
  assert.throws(
    () => loadConfig({ ...base, CHAT_THINKING_LEVEL: "turbo" }),
    /CHAT_THINKING_LEVEL must be one of/,
  );
});

test("refuses a workspace that is the filesystem root", () => {
  assert.throws(
    () => loadConfig({ ...base, PI_WORKSPACE_DIR: "/" }),
    /must be a dedicated directory/,
  );
});

test("refuses a workspace that is the home directory", () => {
  assert.throws(
    () => loadConfig({ ...base, PI_WORKSPACE_DIR: "/home/someone", HOME: "/home/someone" }),
    /must be a dedicated directory/,
  );
});
