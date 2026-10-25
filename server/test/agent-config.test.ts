import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentConfigError,
  generateConfigFromEnv,
  resolveAgentConfigMode,
  writeGeneratedModels,
} from "../src/pi/agent-config.ts";

const baseEnv = {
  CHAT_PROVIDER: "synthetic",
  CHAT_MODEL: "syn:large:text",
  CHAT_BASE_URL: "https://api.synthetic.new/openai/v1",
  CHAT_API_KEY: "sk-test-key",
} satisfies NodeJS.ProcessEnv;

test("generate mode writes a models.json the SDK can read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gen-"));
  const path = await writeGeneratedModels({
    runtimeDir: dir,
    config: generateConfigFromEnv({ ...baseEnv }),
  });

  const written = JSON.parse(readFileSync(path, "utf8")) as {
    providers: Record<string, { baseUrl: string; api: string; apiKey: string; models: Array<{ id: string }> }>;
  };
  const provider = written.providers["synthetic"];
  assert.ok(provider, "the provider must be present");
  assert.equal(provider.baseUrl, "https://api.synthetic.new/openai/v1");
  assert.equal(provider.api, "openai-completions");
  assert.equal(provider.apiKey, "sk-test-key");
  assert.deepEqual(provider.models, [{ id: "syn:large:text" }]);
});

test("the generated files are owner-only, because they hold the key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "genperm-"));
  const path = await writeGeneratedModels({ runtimeDir: dir, config: generateConfigFromEnv({ ...baseEnv }) });

  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "auth.json")).mode & 0o777, 0o600);
});

test("auth.json is created empty so Pi's credential lock has a file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "genauth-"));
  await writeGeneratedModels({ runtimeDir: dir, config: generateConfigFromEnv({ ...baseEnv }) });
  assert.equal(readFileSync(join(dir, "auth.json"), "utf8").trim(), "{}");
});

test("optional model fields are written only when given", async () => {
  const dir = mkdtempSync(join(tmpdir(), "genopt-"));
  const path = await writeGeneratedModels({
    runtimeDir: dir,
    config: generateConfigFromEnv({
      ...baseEnv,
      CHAT_CONTEXT_WINDOW: "524288",
      CHAT_MAX_TOKENS: "65536",
      CHAT_REASONING: "true",
    }),
  });
  const model = (JSON.parse(readFileSync(path, "utf8")) as {
    providers: Record<string, { models: Array<Record<string, unknown>> }>;
  }).providers["synthetic"]!.models[0]!;

  assert.equal(model.contextWindow, 524288);
  assert.equal(model.maxTokens, 65536);
  assert.equal(model.reasoning, true);
});

test("generate mode names the missing variables instead of failing obscurely", () => {
  assert.throws(
    () => generateConfigFromEnv({ CHAT_PROVIDER: "p", CHAT_MODEL: "m" }),
    (error: unknown) => {
      assert.ok(error instanceof AgentConfigError);
      assert.match(error.message, /CHAT_BASE_URL/);
      assert.match(error.message, /CHAT_API_KEY/);
      return true;
    },
  );
});

test("mode defaults to generate only when the values for it exist", () => {
  assert.equal(resolveAgentConfigMode({ ...baseEnv }), "generate");
  assert.equal(resolveAgentConfigMode({}), "mounted");
  assert.equal(resolveAgentConfigMode({ CHAT_BASE_URL: "x" }), "mounted");
});

test("an explicit mode always wins", () => {
  assert.equal(resolveAgentConfigMode({ ...baseEnv, PI_AGENT_CONFIG_MODE: "mounted" }), "mounted");
  assert.equal(resolveAgentConfigMode({ PI_AGENT_CONFIG_MODE: "generate" }), "generate");
});
