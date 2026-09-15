import { describe, it, expect } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createMcpSession, mcpTool, McpConnectionError } from "../src/index.js";

async function makeInProcessSession(): Promise<ReturnType<typeof createMcpSession>> {
  const server = new Server({ name: "demo", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "echoes a message",
        inputSchema: { type: "object", properties: { message: { type: "string" } } },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as { message?: string };
    return { content: [{ type: "text", text: `echo: ${args.message ?? ""}` }] };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return createMcpSession("demo", { command: "node" }, { transport: clientTransport });
}

describe("MCP client", () => {
  it("discovers tools from an in-process MCP server", async () => {
    const session = await makeInProcessSession();
    const defs = await session.listTools();
    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe("echo");
    await session.close();
  });

  it("exposes a namespaced tool that calls the MCP server", async () => {
    const session = await makeInProcessSession();
    const [def] = await session.listTools();
    const tool = mcpTool("demo", session, def!);
    expect(tool.name).toBe("mcp__demo__echo");
    const out = await tool.execute({ message: "hi" }, { cwd: process.cwd() });
    expect(out).toContain("echo: hi");
    await session.close();
  });

  it("surfaces connection failure as an explicit error", async () => {
    const failing: Transport = {
      start: async () => {
        throw new Error("boom");
      },
      send: async () => {},
      close: async () => {},
    };
    const session = createMcpSession("bad", { command: "x" }, { transport: failing });
    await expect(session.listTools()).rejects.toThrow(McpConnectionError);
    await expect(session.listTools()).rejects.toThrow(/bad/);
  });
});
