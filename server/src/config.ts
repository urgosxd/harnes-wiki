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

/**
 * An external service this deployment consumes over HTTP.
 *
 * Deliberately named for the ROLE and not for any particular product: this file
 * must not acquire knowledge about how the other service is built, started or
 * configured. Swapping the implementation is then a configuration change, not a
 * code change — which is the whole point of an adapter.
 */
export interface ExternalApiConfig {
  /** Origin only, e.g. `http://host:4173`. Never a path. */
  baseUrl: string;
  /** Deadline for one read, in milliseconds. */
  timeoutMs: number;
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
  /** `undefined` when this deployment consumes no external ingest service. */
  ingestApi: ExternalApiConfig | undefined;
  /**
   * Absolute origin THIS server is reachable at FROM the ingest service, e.g.
   * `http://server:8080`.
   *
   * Needed because a capability URL is handed to another container: a relative path
   * means nothing to it, and the browser's origin names the wrong process.
   * `undefined` disables upload-backed ingests, since there would be no URL to hand
   * over.
   */
  publicBaseUrl: string | undefined;
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

/**
 * Validate the address other CONTAINERS reach this server at.
 *
 * Same origin rules as any other address here (absolute, http(s), no path), because
 * it is used to build URLs that go on the wire. Empty is allowed and means "no
 * upload-backed ingest", which is a real deployment: a service can still be handed
 * a plain URL or path the operator typed.
 */
export function parsePublicBaseUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`PUBLIC_BASE_URL must be an absolute URL, got "${value}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`PUBLIC_BASE_URL must be http or https, got "${url.protocol}"`);
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new ConfigError(
      `PUBLIC_BASE_URL must be an origin with no path, query or fragment, got "${value}"`,
    );
  }
  return `${url.protocol}//${url.host}`;
}

/**
 * Validate the address of the external ingest service.
 *
 * Only rules that hold for ANY http service are enforced here:
 *
 *  - it must be an absolute http(s) origin, because a path or query here would
 *    silently change every request this adapter builds;
 *  - it must not be `0.0.0.0`, which is a bind address rather than a destination:
 *    no service accepts it as the `Host` of a request, so the failure would look
 *    like an upstream bug instead of a configuration mistake.
 *
 * Nothing here encodes how the other service is built or started. If it moves, or
 * is replaced, the fix belongs in the deployment's environment, not in this file.
 */
export function parseExternalApiConfig(
  env: NodeJS.ProcessEnv,
  options: { urlVar: string; timeoutVar: string; timeoutDefault?: number },
): ExternalApiConfig | undefined {
  const raw = env[options.urlVar]?.trim();
  if (!raw) return undefined;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${options.urlVar} must be an absolute URL, got "${raw}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${options.urlVar} must be http or https, got "${url.protocol}"`);
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new ConfigError(
      `${options.urlVar} must be an origin with no path, query or fragment, got "${raw}"`,
    );
  }
  if (url.hostname === "0.0.0.0") {
    throw new ConfigError(
      `${options.urlVar} must be a reachable address, not 0.0.0.0: that is a bind ` +
        "address, so no service accepts it as a request host and every call would fail.",
    );
  }

  const timeoutValue = env[options.timeoutVar]?.trim();
  const timeoutMs = timeoutValue ? Number(timeoutValue) : (options.timeoutDefault ?? 10_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigError(`${options.timeoutVar} must be a positive number, got "${timeoutValue}"`);
  }

  return { baseUrl: `${url.protocol}//${url.host}`, timeoutMs };
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
    ingestApi: parseExternalApiConfig(env, {
      urlVar: "INGEST_API_BASE_URL",
      timeoutVar: "INGEST_API_TIMEOUT_MS",
    }),
    publicBaseUrl: parsePublicBaseUrl(env.PUBLIC_BASE_URL),
  };
}
