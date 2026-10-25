import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { Type } from "typebox";
import type { ThinkingLevelName } from "../config.ts";

/** One MCP server a tenant is allowed to reach. */
export interface TenantMcpServer {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

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
  readonly toolNames: string[];

  private readonly mcpConnections = new Map<string, McpConnection>();
  private closed = false;

  private constructor(
    tenant: TenantDefinition,
    modelRuntime: ModelRuntime,
    resourceLoader: DefaultResourceLoader,
    settingsManager: SettingsManager,
    customTools: ToolDefinition[],
  ) {
    this.tenant = tenant;
    this.modelRuntime = modelRuntime;
    this.resourceLoader = resourceLoader;
    this.settingsManager = settingsManager;
    this.customTools = customTools;
    this.toolNames = customTools.map((tool) => toolName(tool));
  }

  static async create(options: {
    tenant: TenantDefinition;
    agentDir: string;
    workspaceDir: string;
    systemPrompt: string;
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
      // The store is a cache; keeping it beside the mounted (read-only) agent dir
      // would make every start fail to write.
      modelsStorePath: join(workspaceDir, "models-store.json"),
    });

    // The agent dir is a human development config: it holds extensions, skills,
    // AGENTS.md and themes. Every discovery surface is switched off so the chat
    // product never inherits development tooling.
    const resourceLoader = new DefaultResourceLoader({
      cwd: workspaceDir,
      agentDir,
      noExtensions: true,
      noSkills: true,
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
    try {
      for (const server of tenant.mcpServers) {
        if (!tenant.exposedMcpTools.length) break;
        const client = new McpClient({ name: "agentdocumentor", version: "0.1.0" });
        await client.connect(
          new StdioTransport({
            command: server.command,
            args: server.args,
            env: { ...definedEnv(process.env), ...server.env },
          }),
        );
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
