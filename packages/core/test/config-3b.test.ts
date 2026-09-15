import { describe, it, expect } from "vitest";
import { parseConfigFile } from "../src/index.js";

describe("config 3b fields (hosts / mcpServers / lspServers)", () => {
  it("parses hosts, mcpServers (stdio + url), and lspServers", () => {
    const cfg = parseConfigFile(
      JSON.stringify({
        hosts: [{ id: "box", kind: "ssh", host: "1.2.3.4", user: "dev", port: 2222 }],
        mcpServers: {
          db: { command: "mcp-db", args: ["--stdio"], env: { FOO: "bar" } },
          web: { url: "http://localhost:9999/mcp" },
        },
        lspServers: [{ name: "ts", command: "typescript-language-server", args: ["--stdio"], extensions: ["ts"] }],
      }),
      "/x/config.json",
    );
    expect(cfg.hosts).toHaveLength(1);
    expect(cfg.hosts?.[0]).toEqual({ id: "box", kind: "ssh", host: "1.2.3.4", user: "dev", port: 2222 });
    expect(cfg.mcpServers?.db).toEqual({ command: "mcp-db", args: ["--stdio"], env: { FOO: "bar" } });
    expect(cfg.mcpServers?.web).toEqual({ url: "http://localhost:9999/mcp" });
    expect(cfg.lspServers).toHaveLength(1);
  });

  it("rejects a malformed host (missing required fields)", () => {
    expect(() => parseConfigFile(JSON.stringify({ hosts: [{ id: "box" }] }), "/x/config.json")).toThrow(/invalid/i);
  });

  it("still rejects unknown keys", () => {
    expect(() => parseConfigFile('{"bogus": true}', "/x/config.json")).toThrow(/unrecognized|invalid/i);
  });
});
