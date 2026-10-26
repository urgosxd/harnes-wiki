/** Configuration is read once at startup and validated. Nothing here has a
 *  silent default that could point the agent at a real project directory. */
/** Which capabilities the model gets. Invisible in the UI either way. */
export interface ToolsConfig {
  /** `read`, `grep`, `find`, `ls`: reference material the model can consult. */
  readTools: boolean;
  /** The shell. Off by default: it cannot be confined to the workspace. */
  bash: boolean;
  /** `write` and `edit`. */
  writes: boolean;
  /** Skill files under the agent directory. */
  skills: boolean;
}

export interface Config {
  /** Empty in generate mode: the service writes its own Pi configuration. */
  agentDir: string;
  tools: ToolsConfig;
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

  // An agent directory is only needed when credentials come from a mount. In
  // generate mode the service writes models.json itself, so demanding a path here
  // would fail a configuration that is complete.
  const mode = env.PI_AGENT_CONFIG_MODE?.trim() || "mounted";
  const agentDir = mode === "generate" ? (env.PI_AGENT_DIR?.trim() ?? "") : required(env, "PI_AGENT_DIR");

  const flag = (name: string, fallback: boolean): boolean => {
    const value = env[name]?.trim().toLowerCase();
    if (value === undefined || value === "") return fallback;
    return value === "1" || value === "true" || value === "yes";
  };

  return {
    agentDir,
    tools: {
      readTools: flag("AGENT_READ_TOOLS", true),
      // Default off: measured, a shell reads the provider key with one `cat`.
      bash: flag("AGENT_BASH", false),
      writes: flag("AGENT_WRITES", false),
      skills: flag("AGENT_SKILLS", true),
    },
    workspaceDir,
    provider: required(env, "CHAT_PROVIDER"),
    modelId: required(env, "CHAT_MODEL"),
    thinkingLevel,
    databaseUrl: env.DATABASE_URL?.trim() || undefined,
  };
}
