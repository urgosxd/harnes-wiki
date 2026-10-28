import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { prepareWritableAgentDir } from "./pi/agent-dir.ts";
import {
  generateConfigFromEnv,
  resolveAgentConfigMode,
  writeGeneratedModels,
} from "./pi/agent-config.ts";
import { Logger } from "./log.ts";
import { loadConfig } from "./config.ts";
import { createDatabase } from "./db/pool.ts";
import { migrate } from "./db/migrate.ts";
import { ConversationStore } from "./db/conversation-store.ts";
import { TenantRuntime, type TenantDefinition } from "./pi/tenant-runtime.ts";
import { TurnService } from "./api/turn-service.ts";
import { createRouter } from "./http/router.ts";
import { createAuthenticator } from "./http/auth.ts";
import { registerRoutes } from "./api/routes.ts";
import { registerIngestRoutes } from "./api/ingest-routes.ts";
import { IngestClient } from "./ingest/client.ts";
import type { Model } from "@earendil-works/pi-ai";

const SYSTEM_PROMPT = [
  "You are a helpful assistant.",
  "Answer clearly and concisely in the user's language.",
  // Telling the model to hide its own capabilities made it answer "I can't do
  // that" when asked what it could do. Say what it has, without exposing internals.
  "You may have tools and skills available for reading files in your workspace and for business data.",
  "When the user asks what you can do, describe your capabilities in plain language and try the tools available to you.",
  "Never reveal tool names, internal identifiers, credentials or how you are implemented.",
].join(" ");


async function main(): Promise<void> {
  const log = new Logger({ level: (process.env.LOG_LEVEL as "debug" | "info" | "warn" | "error") ?? "info" });
  const config = loadConfig();
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  await mkdir(config.workspaceDir, { recursive: true });

  // The container is self-contained by default: it writes its own Pi configuration
  // from environment variables, so nothing has to be mounted from the host. A
  // mounted agent directory remains supported for a team secret or a developer
  // pointing at their own credentials.
  // The agent directory is a SIBLING of the workspace, never inside it. The read
  // tool is confined to the workspace, so putting the generated models.json inside
  // it would leave the provider key within reach: measured, the model read the file
  // and only a policy in its prompt stopped it from printing the key. Structure is
  // a boundary; a prompt is not.
  const runtimeAgentDir = resolve(config.workspaceDir, "..", "agent");
  const agentMode = resolveAgentConfigMode(process.env);
  let effectiveAgentDir: string;
  if (agentMode === "generate") {
    const generated = await writeGeneratedModels({
      runtimeDir: runtimeAgentDir,
      config: generateConfigFromEnv(process.env),
    });
    effectiveAgentDir = runtimeAgentDir;
    // Never log the key itself; only where the file was written.
    log.info("generated pi model configuration", { path: generated, provider: config.provider });
  } else {
    // Pi's credential store writes beside auth.json, so a read-only mount cannot be
    // used directly. Credentials are copied into the workspace volume instead.
    effectiveAgentDir = await prepareWritableAgentDir({
      sourceDir: config.agentDir,
      runtimeDir: runtimeAgentDir,
    });
    log.info("mounted agent credentials prepared", { agentDir: effectiveAgentDir });
  }

  const db = createDatabase(config.databaseUrl);
  const migration = await migrate(db);
  if (migration.applied.length > 0) {
    log.info("migrations applied", { migrations: migration.applied });
  }

  const store = new ConversationStore(db);

  // A process that died mid-turn leaves runs stuck in "running", which would keep
  // their conversations locked forever.
  const swept = await store.failInterruptedRuns();
  if (swept > 0) {
    log.warn("interrupted runs swept", { count: swept });
  }

  // One runtime per user, built on first use and reused afterwards: it holds the
  // model runtime, the resource loader and the MCP client connections.
  const runtimes = new Map<string, Promise<TenantRuntime>>();

  const runtimeFor = async (userId: string): Promise<TenantRuntime> => {
    const existing = runtimes.get(userId);
    if (existing) return existing;

    const created = (async () => {
      const servers = await store.listMcpServers(userId);
      const scopes = await store.listScopes(userId);
      const tenant: TenantDefinition = {
        id: userId,
        mcpServers: servers.map((server) => ({
          name: server.serverName,
          command: server.command,
          args: server.args,
          env: server.env,
        })),
        exposedMcpTools: servers.flatMap((server) => server.exposedTools),
        scopes,
      };
      return TenantRuntime.create({
        tenant,
        agentDir: effectiveAgentDir,
        workspaceDir: config.workspaceDir,
        systemPrompt: SYSTEM_PROMPT,
        capabilities: config.tools,
      });
    })();

    runtimes.set(userId, created);
    // A runtime that failed to build must not be cached as a permanent failure.
    created.catch(() => runtimes.delete(userId));
    return created;
  };

  const modelFor = (runtime: TenantRuntime): Model<never> => {
    const model = runtime.modelRuntime.getModel(config.provider, config.modelId);
    if (!model) {
      throw new Error(
        `model ${config.provider}/${config.modelId} is not available; ` +
          `check the generated or mounted Pi configuration in ${effectiveAgentDir}`,
      );
    }
    return model as unknown as Model<never>;
  };

  // Warm the model catalog once, so the first user turn is not the first caller.
  const warm = await runtimeFor("__warmup__").catch(() => undefined);
  if (warm) {
    modelFor(warm);
    runtimes.delete("__warmup__");
    await warm.close().catch(() => undefined);
  }

  const turns = new TurnService({
    store,
    runtimeFor,
    workspaceDir: config.workspaceDir,
    agentDir: effectiveAgentDir,
    modelFor,
    thinkingLevel: config.thinkingLevel,
  });

  const authenticator = createAuthenticator({
    users: process.env.CHAT_USERS,
    devToken: process.env.DEV_AUTH_TOKEN,
  });
  if (!process.env.CHAT_USERS && !process.env.DEV_AUTH_TOKEN) {
    log.warn("no CHAT_USERS or DEV_AUTH_TOKEN: every request will be refused");
  } else if (!process.env.CHAT_USERS) {
    log.warn(
      "DEV_AUTH_TOKEN is set but CHAT_USERS is not: one shared token means any client " +
        "can claim any user id. Set CHAT_USERS=id:token,id:token for per-user identities.",
    );
  }

  const router = createRouter({ authenticate: authenticator });
  registerRoutes(router, { store, turns });

  // The external ingest service is reached server-side only, because it validates
  // its own request headers and cannot be called from the browser's origin. When no
  // address is configured the routes still answer 503 with their own code, which
  // tells the client "not configured" instead of "no such job".
  const ingest = config.ingestApi
    ? new IngestClient({ baseUrl: config.ingestApi.baseUrl, timeoutMs: config.ingestApi.timeoutMs })
    : undefined;
  registerIngestRoutes(router, { ingest });
  if (config.ingestApi) {
    log.info("ingest service adapter configured", {
      baseUrl: config.ingestApi.baseUrl,
      timeoutMs: config.ingestApi.timeoutMs,
    });
  } else {
    log.warn("INGEST_API_BASE_URL is not set: ingest job routes will answer 503");
  }

  const port = Number(process.env.PORT ?? 8080);
  const server = await router.listen(port, "0.0.0.0");
  log.info("agent server listening", { port });

  const shutdown = async (signal: string) => {
    log.info("shutting down", { signal });
    server.close();
    await Promise.allSettled([...runtimes.values()].map(async (p) => (await p).close()));
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  // A structured fatal line, so a crash is greppable like everything else.
  process.stdout.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: "error",
      message: "fatal",
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exit(1);
});
