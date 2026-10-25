#!/usr/bin/env node
/**
 * A minimal MCP server over stdio, used to count processes.
 *
 * Its only job is to be observable: every instance appends its pid to the file in
 * FAKE_MCP_PID_FILE when it starts and records its exit when it stops. That is how
 * the isolation test proves MCP connections do not multiply with sessions or turns.
 *
 * It implements just enough of the protocol for a client to connect and list tools.
 */
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const pidFile = process.env.FAKE_MCP_PID_FILE;
if (pidFile) appendFileSync(pidFile, `start ${process.pid}\n`);

process.on("exit", () => {
  if (pidFile) appendFileSync(pidFile, `exit ${process.pid}\n`);
});

const TOOLS = [
  {
    name: "whoami",
    description: "Returns the tenant this server instance serves.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on("line", (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }

  // Notifications carry no id and expect no response.
  if (request.id === undefined) return;

  switch (request.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-mcp", version: "0.0.1" },
        },
      });
      break;

    case "tools/list":
      send({ jsonrpc: "2.0", id: request.id, result: { tools: TOOLS } });
      break;

    case "tools/call":
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [
            {
              type: "text",
              text: `fake-mcp pid=${process.pid} tenant=${process.env.FAKE_MCP_TENANT ?? "unknown"}`,
            },
          ],
        },
      });
      break;

    case "ping":
      send({ jsonrpc: "2.0", id: request.id, result: {} });
      break;

    default:
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: `method not found: ${request.method}` },
      });
  }
});

lines.on("close", () => process.exit(0));
