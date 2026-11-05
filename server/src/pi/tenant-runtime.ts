import { STACK_TOOLS } from "../../scripts/provision-mcp.mjs";
import { McpClient, StdioTransport, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { Logger, type LogLevel } from "../log.ts";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import { agentToolNames, createAgentTools, type AgentToolOptions } from "./agent-tools.ts";
import { currentStackId } from "./stack-context.ts";
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
      /**
       * Sent on every request; some servers refuse the call without them.
       *
       * The Stack is deliberately NOT here. It is not deployment configuration: it
       * comes from the request that started the turn, through `stack-context.ts`, so
       * one shared upstream cannot be pointed at one Stack on everyone's behalf.
       */
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
        // Keep the whole tool descriptor, not just its name: the model needs the
        // real parameter schema to know a tool takes `stackId`, a `limit`, or
        // anything else. A proxy that discards the schema forces the model to guess
        // and then produces calls the server rejects.
        const available = await client.listTools();
        const byName = new Map(available.map((tool) => [tool.name, tool]));
        const wanted = tenant.exposedMcpTools.filter((name) => byName.has(name));
        tools.push(
          ...proxyMcpTools(
            tenant.id,
            client,
            wanted.map((name) => byName.get(name)!),
          ),
        );
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
 *
 * The Stack of every call is resolved HERE, per call: from the `stackId` the caller
 * stated explicitly, else from the request's context — never from the tenant's row.
 * See `resolveStackArgument`.
 */
export function proxyMcpTools(
  tenantId: string,
  client: McpClient,
  tools: readonly { name: string; description?: string; inputSchema?: Record<string, unknown> }[],
  log: Logger = processLog(),
): ToolDefinition[] {
  return tools.map((tool) =>
    defineTool({
      name: tool.name,
      label: tool.name,
      // The server's own description when it has one, because it is the only text
      // that knows what the tool actually does. The tenant prefix stays so a
      // multi-server deployment can tell two same-named tools apart.
      description: tool.description ?? `Tenant ${tenantId} MCP tool ${tool.name}`,
      // The server's parameter schema, passed through. `additionalProperties: true`
      // is kept so a caller can still send a field this build does not know about —
      // but the declared properties are what let the model see `stackId` at all.
      parameters: Type.Unsafe<Record<string, unknown>>(
        tool.inputSchema && Object.keys(tool.inputSchema).length > 0
          ? { ...tool.inputSchema, additionalProperties: true }
          : { type: "object", properties: {}, additionalProperties: true },
      ),
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const args = params ?? {};
        // A tool that belongs to no Stack is called exactly as before: injecting a
        // Stack into it would send a field it never declared.
        if (!isStackScoped(tool.inputSchema, tool.name)) return await callAndShape(client, tool.name, args);

        const resolved = resolveStackArgument(tool.name, args, log);
        if ("error" in resolved) return toolError(resolved.error);
        return await callAndShape(client, tool.name, resolved.args);
      },
    }) as unknown as ToolDefinition,
  );
}

/**
 * Resolve the `stackId` a Stack-scoped call must carry, and say so out loud when it
 * differs from what the turn's link names.
 *
 * The order is the user's, verbatim: "si el usuario indica que se use otro se usará,
 * pero como fallback siempre el de la URL". An explicit argument therefore WINS, the
 * link's Stack is the FALLBACK, and neither is ever read from a stored default. When
 * neither source names a Stack the call is refused rather than sent with an empty one:
 * an empty `stackId` inherits whatever Stack the upstream happens to sit on, which is
 * the 2026-10-28 incident this feature exists to remove.
 *
 * A differing argument is a choice, not the contradiction the previous rule read it as
 * (S10 of `multitenant-stackId.md`, superseded). It is still a divergence from the
 * Stack the page was showing, so it is recorded once instead of happening silently.
 */
function resolveStackArgument(
  toolName: string,
  args: Record<string, unknown>,
  log: Logger,
): { args: Record<string, unknown> } | { error: string } {
  const turnStackId = currentStackId();
  const named = args.stackId;
  const absent = named === undefined || named === null;
  // Trimmed, because the link is trimmed too (`withStackContext`): `" B "` and `"B"`
  // name the same Stack, and one Stack must not travel under two spellings.
  const explicitStackId = typeof named === "string" ? named.trim() : "";

  // An explicit choice wins, with or without a Stack of the turn's own. The record is
  // written only for a real divergence: no context means nothing was overridden.
  if (explicitStackId !== "") {
    if (turnStackId !== undefined && explicitStackId !== turnStackId) {
      log.info("tool call overrides the turn's Stack", {
        tool: toolName,
        turnStackId,
        argumentStackId: explicitStackId,
      });
    }
    return { args: { ...args, stackId: explicitStackId } };
  }

  // Nothing explicit and no link Stack: the one case with no source at all.
  if (!turnStackId) {
    return {
      error:
        `${toolName} works on one Stack, and this turn has no Stack. ` +
        "Open the app with a link that names it — ?user=<name>&stackId=<stack-id> — and ask again.",
    };
  }

  // Anything that is neither absent nor a string is a TYPE problem, and saying "you
  // named Stack 42" would describe a Stack that cannot exist. Different mistake,
  // different sentence. `null` counts as absent, exactly as it always has.
  if (!absent && typeof named !== "string") {
    return {
      error:
        `${toolName} takes stackId as a string, and the call sent a ${Array.isArray(named) ? "array" : typeof named}. ` +
        "Call it again without stackId to use this turn's Stack.",
    };
  }

  // Absent or blank is not a choice: the model left the field out and the request
  // supplies it. Blank counts here for the same reason the link does — `stackId: ""`
  // names no Stack, it just looks like it does.
  return { args: { ...args, stackId: turnStackId } };
}

let processLogger: Logger | undefined;

/**
 * The logger an override record goes to when the caller supplies none.
 *
 * `main.ts` builds the process `Logger` from `LOG_LEVEL`, and `TenantRuntime.create`
 * does not carry one down to the proxy, so the same shape is built here: one JSON
 * object per line, same threshold, the existing `log.ts` class rather than a second
 * logging mechanism. Tests inject their own through `proxyMcpTools` instead of
 * scraping the process output.
 */
function processLog(): Logger {
  processLogger ??= new Logger({
    level: (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info",
  });
  return processLogger;
}

/**
 * Is this tool scoped to one Stack?
 *
 * ## The rule, stated so it cannot drift
 *
 * A tool is Stack-scoped iff its published schema is unreadable or of unknown shape,
 * OR it is a readable flat object whose `properties` include `stackId`.
 *
 * It is NOT Stack-scoped only when the schema is a readable flat object with
 * `properties` present that does not include `stackId` **and** the name is not one
 * this repository already grants as a Stack tool — the single shape where "no Stack"
 * is a fact instead of a guess.
 *
 * ## Why unknown counts as scoped
 *
 * Parity, not caution. The baseline injected a Stack into EVERY call without looking
 * at the schema at all, so treating an unknown shape as scoped can only NARROW the
 * read scope relative to that baseline, never widen it. Reading it the other way —
 * junk schema means "no Stack" — calls the upstream unscoped, silently, with a
 * success exit, which is the failure this whole feature exists to remove.
 *
 * `additionalProperties: true`, `allOf`/`anyOf`/`oneOf`/`$ref` composition and an
 * absent `properties` are unknown for exactly that reason: a `stackId` can hide
 * inside any of them, so "I cannot see one" is not "there is none".
 */
function isStackScoped(inputSchema: Record<string, unknown> | undefined, name: string): boolean {
  // Rule (c): a name this repository already maintains as a Stack tool is one, whatever
  // its schema says. `list_stacks` is the case that needs it — it reads a Stack but
  // publishes no `stackId`, so the schema alone would call it unscoped and an unscoped
  // listing exposes other tenants' Stack inventory.
  //
  // This is not new knowledge about another service: `STACK_TOOLS` is the constant that
  // already GRANTS those tools at provisioning time (`scripts/provision-mcp.mjs:127`),
  // maintained in this repository. Reading it here keeps one definition instead of
  // starting a second list that would drift.
  if (STACK_TOOLS.includes(name)) return true;

  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) return true;

  // Composition hides parameters from a flat read.
  if (["allOf", "anyOf", "oneOf", "not", "$ref"].some((key) => key in inputSchema)) return true;
  // `additionalProperties: true` says anything may travel, a Stack included.
  if ((inputSchema as { additionalProperties?: unknown }).additionalProperties === true) return true;

  const { properties } = inputSchema as { properties?: unknown };
  // No readable property list at all: the shape is unknown, so it stays scoped. This is
  // rule (a), and it must not be lost behind the nested scan below.
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return true;

  // A `stackId` declared anywhere under `properties`, however deep, is a Stack
  // declaration: a filter object is the obvious shape, and calling such a tool unscoped
  // is exactly the read this feature removes.
  // `unknown` counts as scoped, exactly like rule (a): a tree too deep or too tangled
  // to read is not a promise that no Stack is in there.
  return declaresStackId(inputSchema, 0, new Set()) !== "none";
}

/**
 * How deep the search goes before it calls the schema unreadable.
 *
 * A contract does not nest eight levels; the cap exists so a hostile or generated schema
 * cannot turn a tool call into a long walk. Exceeding it is `unknown`, never `none`:
 * "I stopped looking" must not read as "there is nothing there".
 */
const NESTED_SCHEMA_DEPTH = 8;

/** What a scan of the schema tree found. `unknown` counts as scoped. */
type StackScan = "found" | "unknown" | "none";

/**
 * Find a `stackId` under any `properties` object in the tree.
 *
 * Bounded by `NESTED_SCHEMA_DEPTH`, and guarded against revisiting a node: a schema that
 * shares or repeats a subschema is legal to hand us, and a walk that followed it
 * forever would take the turn down instead of judging one call. Today a truly cyclic
 * schema is refused earlier — `proxyMcpTools` clones the schema through typebox, which
 * overflows first — so the guard is the belt to that braces: it costs a Set and it is
 * the difference between "unknown, refuse" and a stack overflow if that ever changes.
 */
function declaresStackId(schema: unknown, depth: number, visited: Set<unknown>): StackScan {
  if (depth > NESTED_SCHEMA_DEPTH) return "unknown";
  if (!schema || typeof schema !== "object") return "none";
  if (visited.has(schema)) return "unknown";
  visited.add(schema);

  const node = schema as Record<string, unknown>;
  let sawUnknown = false;
  const properties = node.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    const declared = properties as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(declared, "stackId")) return "found";
    for (const nested of Object.values(declared)) {
      const scan = declaresStackId(nested, depth + 1, visited);
      if (scan === "found") return "found";
      if (scan === "unknown") sawUnknown = true;
    }
  }

  // Composition and array items can carry an object schema of their own.
  for (const key of ["allOf", "anyOf", "oneOf", "items", "additionalProperties", "not"]) {
    const branch = node[key];
    const branches = Array.isArray(branch) ? branch : branch && typeof branch === "object" ? [branch] : [];
    for (const entry of branches) {
      const scan = declaresStackId(entry, depth + 1, visited);
      if (scan === "found") return "found";
      if (scan === "unknown") sawUnknown = true;
    }
  }

  return sawUnknown ? "unknown" : "none";
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

/** Call the upstream and shape its answer for the model. */
async function callAndShape(
  client: McpClient,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const result = await client.callTool(name, args);
  const text = (result.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => ({ type: "text" as const, text: block.text }));
  return {
    content: text.length ? text : [{ type: "text" as const, text: "(no text content)" }],
    details: {},
    isError: Boolean(result.isError),
  };
}

/** A refusal the model can read and act on, in the same shape as a tool error. */
function toolError(text: string): ToolResult {
  return { content: [{ type: "text", text }], details: {}, isError: true };
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
