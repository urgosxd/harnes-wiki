import { existsSync } from "node:fs";
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
import { createAuthenticator, parseAuthMode, resolveDeploymentAuthMode } from "./http/auth.ts";
import { registerRoutes } from "./api/routes.ts";
import { SYSTEM_PROMPT } from "./pi/system-prompt.ts";
import {
  loadAgentDefinitions,
  unsupportedKeysFor,
  type AgentDefinition,
} from "./pi/agents.ts";
import { AgentRoleReader, type AgentRoleSource } from "./pi/agent-role.ts";
import { registerIngestRoutes } from "./api/ingest-routes.ts";
import { registerDocumentRoutes, capabilityPath } from "./api/document-routes.ts";
import { DocumentStore } from "./db/document-store.ts";
import { IngestClient } from "./ingest/client.ts";
import type { Model } from "@earendil-works/pi-ai";




async function main(): Promise<void> {
  const log = new Logger({ level: (process.env.LOG_LEVEL as "debug" | "info" | "warn" | "error") ?? "info" });
  const config = loadConfig();
  // Reported the moment it is known, before any later check can fail the boot: an
  // operator debugging a tool that died mid-turn needs this number on the record even when
  // another misconfiguration is what stops the process. It used to be the MCP client
  // library's 30 s, invisible in every log this server writes — measured, `query_wiki`
  // timed out at exactly that on a large Stack. Exactly one line, and it names the
  // EFFECTIVE value, so the default is visible too.
  log.info("mcp request timeout", { timeoutMs: config.mcpRequestTimeoutMs });
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  // Agent definitions are the product's own: pi core has no discovery for them, so
  // nothing else would ever read this directory. A missing directory is normal, since
  // the mount is optional. An unparseable file still fails the boot here — a role
  // nobody could read is not a role — but a KEY this runtime cannot honor does not:
  // a directory mounted from an existing pi-herdsman setup carries `tools`, `model`
  // and `thinking` on every file, and refusing them would make the whole feature
  // unusable for the definitions it exists to consume. Those keys are reported per
  // file and the strictness applies only to the definition actually selected.
  if (!existsSync(config.agentsDir)) {
    log.warn("agent definitions directory not found", { dir: config.agentsDir });
  }
  const loaded = loadAgentDefinitions(config.agentsDir);
  const agentDefinitions = loaded.definitions;
  for (const entry of loaded.unsupported) {
    log.warn(
      `agent definition ${entry.file} carries ${entry.keys.join(", ")}: ignored by this runtime, ` +
        "which cannot honor pi-herdsman tools, model or thinking. Selecting this definition " +
        "fails the boot until those keys are removed.",
      { file: entry.file, keys: entry.keys },
    );
  }
  let agentDefinition: AgentDefinition | undefined;
  if (config.agentDefinition) {
    agentDefinition = agentDefinitions.get(config.agentDefinition);
    if (!agentDefinition) {
      // Falling back to the plain prompt would run a deployment that asked for a role
      // and did not get it, which is the one failure nobody would notice.
      const available = [...agentDefinitions.keys()].join(", ") || "(none found)";
      throw new Error(
        `AGENT_DEFINITION "${config.agentDefinition}" was not found in ${config.agentsDir}; ` +
          `available: ${available}`,
      );
    }
    // Strictness moved from the directory to the selection. Every other definition
    // keeps loading; the one that will actually shape the prompt must be honest about
    // what it asked for, because a half-honored role is worse than a refused one.
    const ignoredKeys = unsupportedKeysFor(loaded, agentDefinition.name);
    if (ignoredKeys.length > 0) {
      throw new Error(
        `AGENT_DEFINITION "${agentDefinition.name}" carries unsupported frontmatter key(s) ` +
          `${ignoredKeys.join(", ")}, which this runtime cannot honor. Remove them from ` +
          `the definition or select another one; available: ` +
          `${[...agentDefinitions.keys()].join(", ")}`,
      );
    }
  }
  log.info("agent definitions loaded", {
    dir: config.agentsDir,
    count: agentDefinitions.size,
    ...(agentDefinition ? { selected: agentDefinition.name } : {}),
  });

  // Two different things, deliberately separated:
  //
  //  * the SELECTION is `AGENT_DEFINITION`, a boot-time fact. Changing it still needs a
  //    restart, because it is deployment configuration (S8 of `role-by-volume.md`);
  //  * the role's TEXT is read per turn from the file that definition was loaded from
  //    (`AgentRoleReader`), so correcting a bad instruction is an edit and not a release.
  //
  // Boot keeps failing fast (S7) — the checks above already threw — and the per-turn path
  // is the softer one: an unreadable file there keeps the last valid text and warns.
  const roleReader = new AgentRoleReader({ log });
  const roleFile = agentDefinition ? loaded.files.get(agentDefinition.name) : undefined;
  if (agentDefinition && !roleFile) {
    // Only reachable if the loader returned a definition without its origin, which would
    // make the per-turn read impossible. Not a soft failure: a deployment that selected a
    // role it cannot re-read would look healthy and behave like an older version.
    throw new Error(
      `AGENT_DEFINITION "${agentDefinition.name}" was loaded without its file path, so the ` +
        "role could not be re-read on each turn; check the directory " + config.agentsDir,
    );
  }
  const roleSource: AgentRoleSource | undefined =
    agentDefinition && roleFile ? { name: agentDefinition.name, path: roleFile } : undefined;

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
        // The transport decides what a row needs, so the mapping branches instead
        // of inventing an empty command for an http server. The database
        // constraint already guarantees the field that matters is present.
        mcpServers: servers.map((server) =>
          server.transport === "http"
            ? {
                transport: "http" as const,
                name: server.serverName,
                url: server.url ?? "",
                ...(Object.keys(server.headers).length > 0 ? { headers: server.headers } : {}),
              }
            : {
                transport: "stdio" as const,
                name: server.serverName,
                command: server.command ?? "",
                args: server.args,
                env: server.env,
              },
        ),
        exposedMcpTools: servers.flatMap((server) => server.exposedTools),
        scopes,
      };
      return TenantRuntime.create({
        tenant,
        agentDir: effectiveAgentDir,
        workspaceDir: config.workspaceDir,
        systemPrompt: SYSTEM_PROMPT,
        capabilities: config.tools,
        mcpRequestTimeoutMs: config.mcpRequestTimeoutMs,
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
    ...(roleSource
      ? {
          roleForTurn: (runtime) =>
            roleReader.resolve(roleSource, runtime.exposedToolNames),
        }
      : {}),
  });

  const authConfig = {
    mode: parseAuthMode(process.env.AUTH_MODE),
    users: process.env.CHAT_USERS,
    devToken: process.env.DEV_AUTH_TOKEN,
    // Password mode reads sessions from here. Injected rather than reached for, so the
    // authenticator is the only thing that knows an account lookup happens.
    db,
  };
  // An explicit `AUTH_MODE` wins, then the legacy inference, then the product default
  // (password). A deployment that forgot the variable must NOT end up trusting a claimed
  // name, which is why the fallback is not `open`.
  const authMode = resolveDeploymentAuthMode(authConfig);
  const authenticator = createAuthenticator({ ...authConfig, mode: authMode });

  // Say which scheme is live, and say it loudly when the scheme has no secret. An
  // operator reading the logs should never have to infer whether callers are
  // identified or merely self-declared.
  if (authMode === "open") {
    log.warn(
      "AUTH_MODE=open: identity is the claimed x-user-id and there is no secret behind " +
        "it. Anyone who can reach this server can act as any user.",
      { authMode },
    );
    if (process.env.CHAT_USERS?.trim()) {
      log.warn("CHAT_USERS is set but AUTH_MODE=open: the roster is being ignored", {
        authMode,
      });
    }
  } else if (authMode === "shared-token") {
    log.warn(
      "AUTH_MODE resolves to shared-token: one token for everyone means any client can " +
        "claim any user id. Set CHAT_USERS=id:token,id:token for per-user identities.",
      { authMode },
    );
  } else if (authMode === "roster") {
    log.info("identity resolved from a per-user roster", { authMode });
  } else {
    // Password mode, whether chosen or defaulted. Worth a line: it is the mode where
    // accounts have to exist, and an operator seeing 401s should be able to tell that
    // from the log before opening the database.
    log.info("identity resolved from username/password sessions", { authMode });
  }

  const router = createRouter({ authenticate: authenticator });
  registerRoutes(router, { store, turns, db, authMode, publicBaseUrl: config.publicBaseUrl });

  // The external ingest service is reached server-side only, because it validates
  // its own request headers and cannot be called from the browser's origin. When no
  // address is configured the routes still answer 503 with their own code, which
  // tells the client "not configured" instead of "no such job".
  const ingest = config.ingestApi
    ? new IngestClient({ baseUrl: config.ingestApi.baseUrl, timeoutMs: config.ingestApi.timeoutMs })
    : undefined;

  // Uploads. The capability URL is only meaningful when the ingest service can
  // reach THIS server, so the public address gates the whole feature: with no
  // address there is nothing to hand over, and the route says so instead of
  // creating documents nobody can read.
  const documents = new DocumentStore(db);
  const documentResolver = config.publicBaseUrl
    ? {
        urlFor: async (documentId: string, userId: string) => {
          const found = await documents.findOwned(documentId, userId);
          if (!found) return undefined;
          return `${config.publicBaseUrl}${capabilityPath(found)}`;
        },
      }
    : undefined;
  registerDocumentRoutes(router, { documents, publicBaseUrl: config.publicBaseUrl });
  registerIngestRoutes(router, { ingest, documents: documentResolver });
  if (config.ingestApi) {
    log.info("ingest service adapter configured", {
      baseUrl: config.ingestApi.baseUrl,
      timeoutMs: config.ingestApi.timeoutMs,
    });
  } else {
    log.warn("INGEST_API_BASE_URL is not set: ingest job routes will answer 503");
  }
  if (!config.publicBaseUrl) {
    log.info("PUBLIC_BASE_URL is not set: uploads are listed and stored, but cannot be ingested");
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
