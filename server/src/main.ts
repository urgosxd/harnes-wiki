import { mkdir } from "node:fs/promises";
import { loadConfig } from "./config.ts";
import { createDatabase } from "./db/pool.ts";
import { migrate } from "./db/migrate.ts";
import { ConversationStore } from "./db/conversation-store.ts";
import { TenantRuntime, type TenantDefinition } from "./pi/tenant-runtime.ts";
import { TurnService } from "./api/turn-service.ts";
import { createRouter } from "./http/router.ts";
import { createAuthenticator } from "./http/auth.ts";
import { registerRoutes } from "./api/routes.ts";
import type { Model } from "@earendil-works/pi-ai";

const SYSTEM_PROMPT = [
  "You are a helpful assistant.",
  "Answer clearly and concisely in the user's language.",
  "You have business tools available. Use them when the user asks for business data.",
  "Never mention tool names, internal identifiers, or how you are implemented.",
].join(" ");

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  await mkdir(config.workspaceDir, { recursive: true });

  const db = createDatabase(config.databaseUrl);
  const migration = await migrate(db);
  if (migration.applied.length > 0) {
    console.log(`migrations applied: ${migration.applied.join(", ")}`);
  }

  const store = new ConversationStore(db);

  // A process that died mid-turn leaves runs stuck in "running", which would keep
  // their conversations locked forever.
  const swept = await store.failInterruptedRuns();
  if (swept > 0) {
    console.log(`marked ${swept} interrupted run(s) as failed`);
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
        agentDir: config.agentDir,
        workspaceDir: config.workspaceDir,
        systemPrompt: SYSTEM_PROMPT,
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
        `model ${config.provider}/${config.modelId} is not available; check models.json in ${config.agentDir}`,
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
    agentDir: config.agentDir,
    modelFor,
    thinkingLevel: config.thinkingLevel,
  });

  const authenticator = createAuthenticator({ devToken: process.env.DEV_AUTH_TOKEN });
  if (!process.env.DEV_AUTH_TOKEN) {
    console.warn(
      "DEV_AUTH_TOKEN is not set: every request will be refused. " +
        "This is intentional until real authentication is wired.",
    );
  }

  const router = createRouter({ authenticate: authenticator });
  registerRoutes(router, { store, turns });

  const port = Number(process.env.PORT ?? 8080);
  const server = await router.listen(port, "0.0.0.0");
  console.log(`agent server listening on ${port}`);

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down`);
    server.close();
    await Promise.allSettled([...runtimes.values()].map(async (p) => (await p).close()));
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error("fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
