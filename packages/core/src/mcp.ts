import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import type { McpServerConfig } from "./config.js";
import type { Tool } from "./tools/index.js";

// ---------------------------------------------------------------------------
// MCP client — connect to MCP servers over stdio or streamable HTTP, discover
// their tools, and re-expose them to the native agent as namespaced
// `mcp__<server>__<tool>` Roost tools. Connection failure is an explicit error.
// ---------------------------------------------------------------------------

export class McpConnectionError extends Error {
  constructor(serverName: string, message: string) {
    super(`MCP server "${serverName}": ${message}`);
    this.name = "McpConnectionError";
  }
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpSession {
  readonly serverName: string;
  listTools(): Promise<McpToolDef[]>;
  callTool(name: string, args: unknown): Promise<string>;
  close(): Promise<void>;
}

export interface CreateMcpSessionOptions {
  /** Inject a transport (tests use an in-process MCP server). */
  transport?: Transport;
}

function defaultTransport(config: McpServerConfig): Transport {
  if ("url" in config) {
    return new StreamableHTTPClientTransport(new URL(config.url));
  }
  return new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: config.env,
  });
}

/** Connect lazily; the first `listTools`/`callTool` performs the handshake. */
export function createMcpSession(
  serverName: string,
  config: McpServerConfig,
  opts: CreateMcpSessionOptions = {},
): McpSession {
  const client = new Client({ name: "roost", version: "0.0.0" });
  const transport = opts.transport ?? defaultTransport(config);
  let connected: Promise<void> | null = null;

  const ensureConnected = (): Promise<void> => {
    connected ??= client.connect(transport).catch((err) => {
      connected = null;
      throw new McpConnectionError(
        serverName,
        err instanceof Error ? err.message : String(err),
      );
    });
    return connected;
  };

  return {
    serverName,
    async listTools() {
      await ensureConnected();
      const result = await client.listTools();
      return result.tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown>,
      }));
    },
    async callTool(name, args) {
      await ensureConnected();
      const result = await client.callTool({ name, arguments: args as Record<string, unknown> });
      const content = result.content as unknown as Array<{ type: string; text?: string }>;
      const parts = content
        .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
        .filter((s): s is string => typeof s === "string" && s.length > 0);
      return parts.join("\n") || "(no output)";
    },
    async close() {
      connected = null;
      try {
        await client.close();
      } catch {
        // closing an already-failed transport is not an error worth surfacing
      }
    },
  };
}

/** Wrap one discovered MCP tool as a namespaced Roost tool. */
export function mcpTool(serverName: string, session: McpSession, def: McpToolDef): Tool {
  return {
    name: `mcp__${serverName}__${def.name}`,
    description: def.description || `MCP tool ${def.name} from server ${serverName}`,
    inputSchema: z.record(z.string(), z.unknown()),
    async execute(input) {
      return session.callTool(def.name, input);
    },
  };
}

/** Connect to every configured server and return namespaced Roost tools. */
export async function discoverMcpTools(
  servers: Record<string, McpServerConfig>,
  opts: CreateMcpSessionOptions = {},
): Promise<{ tools: Tool[]; sessions: McpSession[] }> {
  const sessions: McpSession[] = [];
  const tools: Tool[] = [];
  for (const [name, config] of Object.entries(servers)) {
    const session = createMcpSession(name, config, opts);
    sessions.push(session);
    for (const def of await session.listTools()) {
      tools.push(mcpTool(name, session, def));
    }
  }
  return { tools, sessions };
}
