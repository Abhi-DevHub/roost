import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { HostConfig } from "./config.js";
import { SshHost } from "./ssh/index.js";

// ---------------------------------------------------------------------------
// Execution-host route union (BUILD-PLAN B6). A thread targets a host via
// `thread.create.hostId`; `resolveHost` parses the route and `connectHost`
// turns it into a concrete `Host`. Unknown id → `UnresolvableHostError`, never
// a silent fall back to local.
// ---------------------------------------------------------------------------

export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface Host {
  readonly kind: "local" | "ssh";
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listDir(path: string): Promise<DirEntry[]>;
  runCommand(command: string, opts: { cwd: string; timeoutMs?: number }): Promise<CommandResult>;
  git(args: string[], opts: { cwd: string }): Promise<CommandResult>;
  close(): Promise<void>;
}

export type HostRoute =
  | { kind: "local"; hostId: "local" }
  | { kind: "wsl"; hostId: `wsl:${string}`; distro: string }
  | { kind: "ssh"; hostId: `ssh:${string}`; connectionId: string; provider: Host | null }
  | { kind: "runtime"; hostId: `runtime:${string}`; environmentId: string };

export class UnresolvableHostError extends Error {
  constructor(hostId: string) {
    super(`unknown execution host: ${hostId}`);
    this.name = "UnresolvableHostError";
  }
}

export class UnsupportedHostKindError extends Error {
  constructor(kind: string) {
    super(`execution host kind "${kind}" is not supported yet`);
    this.name = "UnsupportedHostKindError";
  }
}

/** Parse `local` / `wsl:<d>` / `ssh:<id>` / `runtime:<id>`. Unknown id throws. */
export function resolveHost(hostId: string, hosts: HostConfig[] = []): HostRoute {
  if (hostId === "local") return { kind: "local", hostId: "local" };
  if (hostId.startsWith("wsl:")) {
    const distro = hostId.slice("wsl:".length);
    if (!distro) throw new UnresolvableHostError(hostId);
    return { kind: "wsl", hostId: hostId as `wsl:${string}`, distro };
  }
  if (hostId.startsWith("ssh:")) {
    const connectionId = hostId.slice("ssh:".length);
    if (!connectionId || !hosts.some((h) => h.id === connectionId)) {
      throw new UnresolvableHostError(hostId);
    }
    return { kind: "ssh", hostId: hostId as `ssh:${string}`, connectionId, provider: null };
  }
  if (hostId.startsWith("runtime:")) {
    const environmentId = hostId.slice("runtime:".length);
    if (!environmentId) throw new UnresolvableHostError(hostId);
    return { kind: "runtime", hostId: hostId as `runtime:${string}`, environmentId };
  }
  throw new UnresolvableHostError(hostId);
}

/** Resolve + connect a host id to a concrete `Host`. */
export function connectHost(hostId: string, hosts: HostConfig[] = []): Host {
  const route = resolveHost(hostId, hosts);
  switch (route.kind) {
    case "local":
      return new LocalHost();
    case "ssh": {
      const cfg = hosts.find((h) => h.id === route.connectionId);
      if (!cfg) throw new UnresolvableHostError(hostId);
      return new SshHost(cfg);
    }
    case "wsl":
    case "runtime":
      throw new UnsupportedHostKindError(route.kind);
  }
}

// ---------------------------------------------------------------------------
// LocalHost — passthrough to node:fs + the platform shell. Identical behavior
// to the pre-host tools/reactor.
// ---------------------------------------------------------------------------

function platformShell(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command] };
  }
  return { file: "bash", args: ["-c", command] };
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
  const { file, args } = platformShell(command);
  return new Promise<CommandResult>((resolvePromise) => {
    const child = spawn(file, args, { cwd, shell: false, windowsHide: true, env: process.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr?.on("data", (c: string) => {
      stderr += c;
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: 1, stdout: "", stderr: `failed to spawn: ${e.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

export class LocalHost implements Host {
  readonly kind = "local" as const;

  static instance(): Host {
    return new LocalHost();
  }

  async readFile(path: string): Promise<string> {
    return readFile(path, "utf8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
  }

  async runCommand(command: string, opts: { cwd: string; timeoutMs?: number }): Promise<CommandResult> {
    return runShell(command, opts.cwd, opts.timeoutMs ?? 30_000);
  }

  async git(args: string[], opts: { cwd: string }): Promise<CommandResult> {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    try {
      const { stdout, stderr } = await execFileAsync("git", args, {
        cwd: opts.cwd,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      });
      return { exitCode: 0, stdout, stderr, timedOut: false };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return { exitCode: 1, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? String(err), timedOut: false };
    }
  }

  async close(): Promise<void> {
    // nothing to release
  }
}
