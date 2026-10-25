/** Configuration is read once at startup and validated. Nothing here has a
 *  silent default that could point the agent at a real project directory. */
export interface Config {
  agentDir: string;
  workspaceDir: string;
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevelName;
  databaseUrl: string | undefined;
}

export type ThinkingLevelName = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const THINKING_LEVELS: readonly ThinkingLevelName[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export class ConfigError extends Error {}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`${name} is required`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const thinkingLevel = (env.CHAT_THINKING_LEVEL?.trim() || "medium") as ThinkingLevelName;
  if (!THINKING_LEVELS.includes(thinkingLevel)) {
    throw new ConfigError(
      `CHAT_THINKING_LEVEL must be one of ${THINKING_LEVELS.join(", ")}, got "${thinkingLevel}"`,
    );
  }

  const workspaceDir = required(env, "PI_WORKSPACE_DIR");
  // Pi appends a <cwd> section to the system prompt even with an override, so the
  // workspace must be a dedicated directory rather than someone's project.
  if (workspaceDir === "/" || workspaceDir === env.HOME) {
    throw new ConfigError(
      "PI_WORKSPACE_DIR must be a dedicated directory, not / or the home directory",
    );
  }

  return {
    agentDir: required(env, "PI_AGENT_DIR"),
    workspaceDir,
    provider: required(env, "CHAT_PROVIDER"),
    modelId: required(env, "CHAT_MODEL"),
    thinkingLevel,
    databaseUrl: env.DATABASE_URL?.trim() || undefined,
  };
}
