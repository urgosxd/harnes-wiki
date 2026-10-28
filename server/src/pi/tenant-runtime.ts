import { McpClient, StdioTransport, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import { agentToolNames, createAgentTools, type AgentToolOptions } from "./agent-tools.ts";
import { Type } from "typebox";
import type { ThinkingLevelName } from "../config.ts";

/**
 * One MCP server a tenant is allowed to reach.
 *
 * Two transports, and the row states which: a `stdio` server is a process THIS
 * container spawns, and an `http` server is one reachable at a URL — which is how
 * an external service is consumed without its binary entering this image.
 *
 * The union is discriminated rather than a bag of optional fields so that a
 * half-specified server is a type error here instead of a confusing connection
 * failure at runtime.
 */
export type TenantMcpServer =
  | {
      transport?: "stdio";
      name: string;
      command: string;
      args: string[];
      env?: Record<string, string>;
    }
  | {
      transport: "http";
      name: string;
      /** Streamable-HTTP endpoint, e.g. `http://host:4173/mcp`. */
      url: string;
      /** Sent on every request; some servers refuse the call without them. */
      headers?: Record<string, string>;
    };

export type TenantToolScope = readonly string[];

export interface TenantDefinition {
  id: string;
  /** MCP servers reachable by this tenant. */
  mcpServers: readonly TenantMcpServer[];
  /** MCP tool names exposed to the model, unprefixed, e.g. `mem_search`. */
  exposedMcpTools: readonly string[];
  /** Business permissions. Enforced inside each tool's execute, not by the prompt. */
  scopes: TenantToolScope;
}

export interface McpConnection {
  server: TenantMcpServer;
  client: McpClient;
  toolNames: string[];
}

/**
 * Everything expensive that a tenant shares across turns: the model runtime, the
 * resource loader, one MCP client per configured server, and the proxied tools.
 *
 * Built once per tenant and reused. A Pi session is cheap (a few ms) and is
 * created per turn instead, because nothing survives a crash mid-turn.
 */
export class TenantRuntime {
  readonly tenant: TenantDefinition;
  readonly modelRuntime: ModelRuntime;
  readonly resourceLoader: DefaultResourceLoader;
  readonly settingsManager: SettingsManager;
  readonly customTools: ToolDefinition[];
  /** Coding tools (read/grep/find/ls and optionally bash/write/edit). */
  readonly builtinTools: AgentTool<TSchema, unknown>[];
  readonly toolNames: string[];

  private readonly mcpConnections = new Map<string, McpConnection>();
  private closed = false;

  private constructor(
    tenant: TenantDefinition,
    modelRuntime: ModelRuntime,
    resourceLoader: DefaultResourceLoader,
    settingsManager: SettingsManager,
    customTools: ToolDefinition[],
    builtinTools: AgentTool<TSchema, unknown>[],
  ) {
    this.tenant = tenant;
    this.modelRuntime = modelRuntime;
    this.resourceLoader = resourceLoader;
    this.settingsManager = settingsManager;
    this.customTools = customTools;
    this.builtinTools = builtinTools;
    // The session's allowlist covers both kinds: built-in names and our own tools.
    this.toolNames = [...builtinTools.map((tool) => tool.name), ...customTools.map((tool) => toolName(tool))];
  }

  static async create(options: {
    tenant: TenantDefinition;
    agentDir: string;
    workspaceDir: string;
    systemPrompt: string;
    /** Which capabilities the model gets. */
    capabilities?: {
      readTools?: boolean;
      bash?: boolean;
      writes?: boolean;
      skills?: boolean;
    };
  }): Promise<TenantRuntime> {
    const { tenant, agentDir, workspaceDir, systemPrompt } = options;

    // The credential and catalog paths are passed explicitly. `ModelRuntime.create()`
    // without them resolves through HOME and PI_CODING_AGENT_DIR, which happens to
    // match the agent dir on a developer machine and resolves to nothing in a
    // container: measured 0 models with a clean HOME versus 7 with explicit paths,
    // and the failure surfaces as "model is not available" at startup.
    const modelRuntime = await ModelRuntime.create({
      allowModelNetwork: false,
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      // The store is a cache and must stay OUT of the workspace: anything inside it
      // is visible to the model's read/ls tools. Measured - with the cache in the
      // workspace the assistant reported "models-store.json" as one of the user's
      // files. It lives beside the agent dir instead, which is already outside.
      modelsStorePath: join(workspaceDir, "..", "models-store.json"),
    });

    // The agent dir is a human development config: it holds extensions, skills,
    // AGENTS.md and themes. Every discovery surface is switched off so the chat
    // product never inherits development tooling.
    const capabilities = {
      readTools: options.capabilities?.readTools ?? true,
      bash: options.capabilities?.bash ?? false,
      writes: options.capabilities?.writes ?? false,
      skills: options.capabilities?.skills ?? true,
    };

    let builtinTools: AgentTool<TSchema, unknown>[] = [];
    const resourceLoader = new DefaultResourceLoader({
      cwd: workspaceDir,
      agentDir,
      noExtensions: true,
      // Skills are documentation the model can consult; they are not a dev surface
      // and are not shown in the UI.
      noSkills: !capabilities.skills,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      // Truthy placeholders stop discovery of configured prompt files; the
      // overrides below keep the placeholders out of the prompt.
      systemPrompt: " ",
      appendSystemPrompt: [" "],
      systemPromptOverride: () => systemPrompt,
      appendSystemPromptOverride: () => [],
    });
    await resourceLoader.reload();

    // One long-lived client per server. Creating a Pi MCP extension per session
    // instead spawns one child process per session that dispose() never reaps.
    const connections = new Map<string, McpConnection>();
    const tools: ToolDefinition[] = [];

    // Coding tools: available to the model, invisible to the user. `read` is
    // confined to the workspace because credentials live beside it.
    if (capabilities.readTools || capabilities.bash || capabilities.writes) {
      builtinTools = createAgentTools({
        workspaceDir,
        enableBash: capabilities.bash,
        enableWrites: capabilities.writes,
      });
    }
    try {
      for (const server of tenant.mcpServers) {
        if (!tenant.exposedMcpTools.length) break;
        const client = new McpClient({ name: "agentdocumentor", version: "0.1.0" });
        await client.connect(transportFor(server));
        const available = new Set((await client.listTools()).map((tool) => tool.name));
        const wanted = tenant.exposedMcpTools.filter((name) => available.has(name));
        tools.push(...proxyMcpTools(tenant.id, client, wanted));
        connections.set(server.name, { server, client, toolNames: wanted });
      }
    } catch (error) {
      await Promise.allSettled([...connections.values()].map((c) => c.client.close()));
      throw error;
    }

    tools.push(...businessTools(tenant));

    const runtime = new TenantRuntime(
      tenant,
      modelRuntime,
      resourceLoader,
      SettingsManager.inMemory({}),
      tools,
      builtinTools,
    );
    for (const [name, connection] of connections) runtime.mcpConnections.set(name, connection);
    return runtime;
  }

  /** Tool names this tenant's sessions may activate. */
  get exposedToolNames(): string[] {
    return this.toolNames;
  }

  mcpStatus(): Array<{ server: string; tools: number; state: string }> {
    return [...this.mcpConnections.values()].map((connection) => ({
      server: connection.server.name,
      tools: connection.toolNames.length,
      state: connection.client.connectionState,
    }));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.mcpConnections.values()].map((c) => c.client.close()));
    this.mcpConnections.clear();
  }
}

/**
 * Build the transport a server row describes.
 *
 * Kept in one place so the two transports cannot drift: the stdio branch spawns a
 * child process, the http branch talks to a URL, and nothing else in this file has
 * to care which.
 */
function transportFor(server: TenantMcpServer): StdioTransport | StreamableHttpTransport {
  if (server.transport === "http") {
    return new StreamableHttpTransport({
      url: server.url,
      ...(server.headers && Object.keys(server.headers).length > 0
        ? { headers: server.headers }
        : {}),
    });
  }
  return new StdioTransport({
    command: server.command,
    args: server.args,
    env: { ...definedEnv(process.env), ...server.env },
  });
}

/** StdioTransport takes a literal environment, so drop the unset variables. */
function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function toolName(tool: ToolDefinition): string {
  return (tool as unknown as { name?: string; definition?: { name: string } }).name
    ?? (tool as unknown as { definition: { name: string } }).definition.name;
}

/**
 * Wrap MCP tools as Pi custom tools.
 *
 * The proxy narrows MCP to direct tools: codemode scripts, tool search and MCP
 * resources are not exposed. A business chat wants plain callable tools, and this
 * keeps one process per server instead of one per session.
 */
function proxyMcpTools(
  tenantId: string,
  client: McpClient,
  names: readonly string[],
): ToolDefinition[] {
  return names.map((name) =>
    defineTool({
      name,
      label: name,
      description: `Tenant ${tenantId} MCP tool ${name}`,
      parameters: Type.Unsafe<Record<string, unknown>>({
        type: "object",
        properties: {},
        additionalProperties: true,
      }),
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const result = await client.callTool(name, params ?? {});
        const text = (result.content ?? [])
          .filter((block) => block.type === "text")
          .map((block) => ({ type: "text" as const, text: block.text }));
        return {
          content: text.length ? text : [{ type: "text" as const, text: "(no text content)" }],
          details: {},
          isError: Boolean(result.isError),
        };
      },
    }) as unknown as ToolDefinition,
  );
}

/**
 * Business tools. Scope is enforced inside execute, so a tenant without the
 * permission gets a tool error rather than a prompt-level suggestion.
 */
function businessTools(tenant: TenantDefinition): ToolDefinition[] {
  return [
    defineTool({
      name: "get_order",
      label: "Get order",
      description: "Look up one order by its id.",
      parameters: Type.Object({ orderId: Type.String({ description: "Order id" }) }),
      execute: async (_toolCallId: string, params: { orderId: string }) => {
        if (!tenant.scopes.includes("orders:read")) {
          return {
            content: [{ type: "text" as const, text: "forbidden: missing orders:read scope" }],
            details: { tenant: tenant.id, orderId: params.orderId },
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `tenant=${tenant.id} order=${params.orderId} status=shipped`,
            },
          ],
          details: { tenant: tenant.id, orderId: params.orderId },
        };
      },
    }) as unknown as ToolDefinition,
  ];
}

/** Thinking level names accepted by Pi. */
export function piThinkingLevel(level: ThinkingLevelName): ThinkingLevelName {
  return level;
}
