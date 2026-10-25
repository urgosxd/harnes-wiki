import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Where the container's own Pi configuration comes from.
 *
 * Two supported modes, and nothing else:
 *
 *  - `generate`: the service writes its own `models.json` from environment
 *    variables. This is the container-native path: no host file, no mounted
 *    directory, and the image never carries credentials.
 *  - `mounted`: an existing agent directory is provided read-only (a team secret,
 *    or a developer pointing at their own). Credentials are copied out of it,
 *    because Pi takes a lock beside `auth.json` and a read-only mount fails.
 *
 * The SDK ships no built-in model catalog - measured: zero models with an empty
 * configuration - so one of these two always applies.
 */
export type AgentConfigMode = "generate" | "mounted";

export interface GenerateConfig {
  provider: string;
  modelId: string;
  baseUrl: string;
  /** One of the API types the SDK understands. */
  api: string;
  apiKey: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Write a minimal but complete `models.json` for one provider and one model.
 *
 * The shape is the documented minimum: provider `baseUrl` and `api`, plus the
 * model `id`. Everything else has defaults in the SDK.
 */
export async function writeGeneratedModels(options: {
  runtimeDir: string;
  config: GenerateConfig;
}): Promise<string> {
  const { runtimeDir, config } = options;
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });

  const model: Record<string, unknown> = { id: config.modelId };
  if (config.contextWindow !== undefined) model.contextWindow = config.contextWindow;
  if (config.maxTokens !== undefined) model.maxTokens = config.maxTokens;
  if (config.reasoning !== undefined) model.reasoning = config.reasoning;

  const document = {
    providers: {
      [config.provider]: {
        baseUrl: config.baseUrl,
        api: config.api,
        apiKey: config.apiKey,
        models: [model],
      },
    },
  };

  const path = join(runtimeDir, "models.json");
  // 0600: this file holds the provider key.
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  // Pi's credential store creates and locks auth.json beside models.json.
  await writeFile(join(runtimeDir, "auth.json"), "{}\n", { mode: 0o600 });
  await chmod(join(runtimeDir, "auth.json"), 0o600);

  return path;
}

/**
 * Read the configuration the image was built with, if any.
 *
 * A bundling factory may put a `models.json` next to the agent directory. Reading
 * it through this function (instead of mounting a host path) is what makes the
 * container self-contained.
 */
export async function hasModelsFile(dir: string): Promise<boolean> {
  try {
    const text = await readFile(join(dir, "models.json"), "utf8");
    const parsed: unknown = JSON.parse(text);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { providers?: unknown }).providers === "object"
    );
  } catch {
    return false;
  }
}

/** Resolve the mode from the environment, failing loudly on an incomplete setup. */
export function resolveAgentConfigMode(env: NodeJS.ProcessEnv): AgentConfigMode {
  const explicit = env.PI_AGENT_CONFIG_MODE?.trim();
  if (explicit === "generate" || explicit === "mounted") return explicit;

  // Default: generate when the values for it are present, otherwise mounted.
  if (env.CHAT_BASE_URL?.trim() && env.CHAT_API_KEY?.trim()) return "generate";
  return "mounted";
}

export class AgentConfigError extends Error {}

export function generateConfigFromEnv(env: NodeJS.ProcessEnv): GenerateConfig {
  const provider = env.CHAT_PROVIDER?.trim();
  const modelId = env.CHAT_MODEL?.trim();
  const baseUrl = env.CHAT_BASE_URL?.trim();
  const api = env.CHAT_API?.trim() || "openai-completions";
  const apiKey = env.CHAT_API_KEY?.trim();

  const missing = [
    !provider && "CHAT_PROVIDER",
    !modelId && "CHAT_MODEL",
    !baseUrl && "CHAT_BASE_URL",
    !apiKey && "CHAT_API_KEY",
  ].filter(Boolean) as string[];

  if (missing.length > 0) {
    throw new AgentConfigError(
      `PI_AGENT_CONFIG_MODE=generate needs ${missing.join(", ")}. ` +
        "Set them, or use PI_AGENT_CONFIG_MODE=mounted with an agent directory.",
    );
  }

  const contextWindow = env.CHAT_CONTEXT_WINDOW ? Number(env.CHAT_CONTEXT_WINDOW) : undefined;
  const maxTokens = env.CHAT_MAX_TOKENS ? Number(env.CHAT_MAX_TOKENS) : undefined;

  return {
    provider: provider!,
    modelId: modelId!,
    baseUrl: baseUrl!,
    api: api!,
    apiKey: apiKey!,
    ...(contextWindow !== undefined && Number.isFinite(contextWindow) ? { contextWindow } : {}),
    ...(maxTokens !== undefined && Number.isFinite(maxTokens) ? { maxTokens } : {}),
    ...(env.CHAT_REASONING === "true" ? { reasoning: true } : {}),
  };
}
