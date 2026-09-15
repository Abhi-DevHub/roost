import { describe, it, expect } from "vitest";
import { LspClient, matchLspServer, formatDiagnostics, type LspConnection } from "../src/index.js";
import type { LspServerConfig } from "../src/index.js";

const tsServer: LspServerConfig = { name: "ts", command: "tsserver", extensions: ["ts", ".tsx"] };
const pyServer: LspServerConfig = { name: "py", command: "pylsp", extensions: ["py"] };
const catchAll: LspServerConfig = { name: "any", command: "ls", extensions: [] };

describe("matchLspServer", () => {
  it("matches by extension (case/leading-dot insensitive)", () => {
    expect(matchLspServer([tsServer, pyServer], "/x/foo.ts")).toBe(tsServer);
    expect(matchLspServer([tsServer, pyServer], "/x/foo.TS")).toBe(tsServer);
    expect(matchLspServer([tsServer, pyServer], "/x/foo.tsx")).toBe(tsServer);
    expect(matchLspServer([tsServer, pyServer], "/x/foo.py")).toBe(pyServer);
  });

  it("returns undefined when nothing matches", () => {
    expect(matchLspServer([tsServer], "/x/foo.js")).toBeUndefined();
  });

  it("treats empty extensions as match-any", () => {
    expect(matchLspServer([catchAll, tsServer], "/x/foo.rb")).toBe(catchAll);
  });
});

function fakeConnection(report?: unknown): LspConnection {
  return {
    sendRequest: async () => (report === undefined ? {} : report),
    sendNotification: async () => {},
    listen: () => {},
    dispose: () => {},
  };
}

describe("LspClient.diagnostics", () => {
  it("returns empty when no server matches", async () => {
    const client = new LspClient({ servers: [tsServer] });
    expect(await client.diagnostics("/x/foo.js")).toEqual([]);
    await client.close();
  });

  it("pulls and parses a full diagnostic report", async () => {
    const report = {
      kind: "full",
      items: [
        {
          range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } },
          severity: 1,
          message: "boom",
        },
      ],
    };
    const client = new LspClient({
      servers: [tsServer],
      connect: async () => fakeConnection(report),
    });
    const diags = await client.diagnostics("/x/foo.ts");
    expect(diags).toEqual([
      { file: "/x/foo.ts", line: 2, column: 3, severity: 1, message: "boom" },
    ]);
    expect(formatDiagnostics(diags)).toContain("boom");
    await client.close();
  });

  it("never blocks on a slow server (timeout → empty)", async () => {
    const hanging: LspConnection = {
      sendRequest: async () => new Promise(() => {}), // never resolves
      sendNotification: async () => {},
      listen: () => {},
      dispose: () => {},
    };
    const client = new LspClient({
      servers: [tsServer],
      connect: async () => hanging,
      timeoutMs: 30,
    });
    const start = Date.now();
    const diags = await client.diagnostics("/x/foo.ts");
    expect(diags).toEqual([]);
    expect(Date.now() - start).toBeLessThan(2_000);
    await client.close();
  });

  it("returns empty when the server fails to connect", async () => {
    const client = new LspClient({
      servers: [tsServer],
      connect: async () => {
        throw new Error("spawn failed");
      },
    });
    expect(await client.diagnostics("/x/foo.ts")).toEqual([]);
    await client.close();
  });
});
