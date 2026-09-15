import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import {
  DocumentDiagnosticRequest,
  InitializeRequest,
  InitializedNotification,
  type Diagnostic,
} from "vscode-languageserver-protocol";
import type { LspServerConfig } from "./config.js";

// ---------------------------------------------------------------------------
// LSP integration — spawn a language server, initialize it, and pull
// diagnostics for a file. No matching server → empty (not an error); a slow
// server never blocks the turn (bounded timeout).
// ---------------------------------------------------------------------------

export interface LspDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: number;
  message: string;
}

/** Minimal structural surface of a vscode-jsonrpc connection (testable). */
export interface LspConnection {
  sendRequest(method: string, params: unknown): Promise<unknown>;
  sendNotification(method: string, params: unknown): Promise<void>;
  listen(): void;
  dispose(): void;
}

export interface LspClientOptions {
  servers: LspServerConfig[];
  timeoutMs?: number;
  /** Inject a connection factory (tests). Defaults to spawning the command. */
  connect?: (config: LspServerConfig) => Promise<LspConnection>;
}

function extensionOf(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? "";
  const idx = base.lastIndexOf(".");
  return idx <= 0 ? "" : base.slice(idx + 1).toLowerCase();
}

/** The first server whose `extensions` cover the file; empty extensions = any file. */
export function matchLspServer(servers: LspServerConfig[], filePath: string): LspServerConfig | undefined {
  const ext = extensionOf(filePath);
  return servers.find((s) => {
    const exts = (s.extensions ?? []).map((e) => e.replace(/^\./, "").toLowerCase());
    return exts.length === 0 || exts.includes(ext);
  });
}

async function defaultConnect(config: LspServerConfig): Promise<LspConnection> {
  const child: ChildProcess = spawn(config.command, config.args ?? [], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout!),
    new StreamMessageWriter(child.stdin!),
  );
  connection.listen();
  await connection.sendRequest(InitializeRequest.type, {
    processId: process.pid,
    rootUri: null,
    capabilities: { textDocument: { diagnostic: {} } },
  });
  await connection.sendNotification(InitializedNotification.type, {});
  return {
    sendRequest: (method, params) => connection.sendRequest(method, params),
    sendNotification: (method, params) => connection.sendNotification(method, params),
    listen: () => connection.listen(),
    dispose: () => {
      connection.dispose();
      child.kill();
    },
  };
}

function parseReport(report: unknown): LspDiagnostic[] {
  if (report == null || typeof report !== "object") return [];
  const r = report as { kind?: string; items?: Diagnostic[] };
  if (r.kind !== "full" || !Array.isArray(r.items)) return [];
  return r.items.map((d) => ({
    file: "",
    line: d.range.start.line + 1,
    column: d.range.start.character + 1,
    severity: d.severity ?? 3,
    message: typeof d.message === "string" ? d.message : d.message.value,
  }));
}

export class LspClient {
  private readonly servers: LspServerConfig[];
  private readonly timeoutMs: number;
  private readonly connect: (config: LspServerConfig) => Promise<LspConnection>;
  private readonly connections = new Map<string, LspConnection>();

  constructor(opts: LspClientOptions) {
    this.servers = opts.servers;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.connect = opts.connect ?? defaultConnect;
  }

  /** Pull diagnostics for `filePath`; empty when no server matches or it times out. */
  async diagnostics(filePath: string): Promise<LspDiagnostic[]> {
    const server = matchLspServer(this.servers, filePath);
    if (!server) return [];

    let connection = this.connections.get(server.name);
    if (!connection) {
      try {
        connection = await this.connect(server);
        this.connections.set(server.name, connection);
      } catch {
        return [];
      }
    }

    const uri = pathToFileURL(filePath).toString();
    try {
      const report = await this.withTimeout(
        connection.sendRequest(DocumentDiagnosticRequest.type.method, {
          textDocument: { uri },
        }),
      );
      return parseReport(report).map((d) => ({ ...d, file: filePath }));
    } catch {
      return [];
    }
  }

  async close(): Promise<void> {
    for (const connection of this.connections.values()) connection.dispose();
    this.connections.clear();
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), this.timeoutMs);
      promise.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        () => {
          clearTimeout(timer);
          resolve(undefined);
        },
      );
    });
  }
}

/** Format diagnostics for a tool result; empty string when there are none. */
export function formatDiagnostics(diags: LspDiagnostic[]): string {
  if (diags.length === 0) return "";
  const lines = diags.map(
    (d) => `${d.file}:${d.line}:${d.column} [${d.severity}] ${d.message}`,
  );
  return `<diagnostics>\n${lines.join("\n")}\n</diagnostics>`;
}
