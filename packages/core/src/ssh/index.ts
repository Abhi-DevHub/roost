import { readFileSync } from "node:fs";
import { Client as Ssh2Client } from "ssh2";
import type { CommandResult, DirEntry, Host } from "../hosts.js";

// ---------------------------------------------------------------------------
// SSH execution host — filesystem (SFTP), command, and git providers over a
// persistent ssh2 connection with lazy reconnect. No shelling out to `ssh`.
// The connection is injectable (`createClient`) so tests mock ssh2 entirely.
// ---------------------------------------------------------------------------

export interface SshChannel {
  on(event: "data", listener: (data: Buffer) => void): void;
  on(event: "close", listener: (code: number | null) => void): void;
  stderr: { on(event: "data", listener: (data: Buffer) => void): void };
  close(): void;
}

export interface SshSftp {
  readFile(path: string, cb: (err: Error | undefined, buf: Buffer) => void): void;
  writeFile(path: string, data: Buffer, cb: (err: Error | undefined) => void): void;
  mkdir(path: string, cb: (err: Error | undefined) => void): void;
  readdir(
    path: string,
    cb: (err: Error | undefined, list: Array<{ filename: string; attrs: { isDirectory(): boolean } }>) => void,
  ): void;
  end(): void;
}

export interface SshClient {
  on(event: "ready", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "close", listener: () => void): void;
  connect(config: Record<string, unknown>): void;
  exec(command: string, cb: (err: Error | undefined, channel: SshChannel) => void): void;
  sftp(cb: (err: Error | undefined, sftp: SshSftp) => void): void;
  end(): void;
}

export class SshUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshUnreachableError";
  }
}

export interface SshHostOptions {
  host: string;
  user: string;
  port?: number;
  keyPath?: string;
  /** Inject a connection factory (tests). Defaults to a real ssh2 client. */
  createClient?: () => SshClient;
}

function defaultCreateClient(): SshClient {
  return new Ssh2Client() as SshClient;
}

/** Quote an argument for the remote POSIX shell (single quotes). */
function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function normalizeList(list: Array<{ filename: string; attrs: { isDirectory(): boolean } }>): DirEntry[] {
  return list.map((e) => ({ name: e.filename, isDirectory: e.attrs.isDirectory() }));
}

export class SshHost implements Host {
  readonly kind = "ssh" as const;

  private readonly opts: SshHostOptions;
  private readonly createClient: () => SshClient;
  private client: SshClient | null = null;
  private connecting: Promise<void> | null = null;
  private ready = false;

  constructor(opts: SshHostOptions) {
    this.opts = opts;
    this.createClient = opts.createClient ?? defaultCreateClient;
  }

  private connectConfig(): Record<string, unknown> {
    const cfg: Record<string, unknown> = {
      host: this.opts.host,
      port: this.opts.port ?? 22,
      username: this.opts.user,
    };
    if (this.opts.keyPath) {
      cfg.privateKey = readFileSync(this.opts.keyPath, "utf8");
    }
    return cfg;
  }

  /** Connect (or reconnect after a drop) the underlying client. */
  private ensureConnected(): Promise<void> {
    if (this.ready && this.client) return Promise.resolve();
    this.connecting ??= new Promise<void>((resolve, reject) => {
      const client = this.createClient();
      this.client = client;
      client.on("ready", () => {
        this.ready = true;
        resolve();
      });
      client.on("error", (err) => {
        this.ready = false;
        this.connecting = null;
        reject(new SshUnreachableError(err.message));
      });
      client.on("close", () => {
        this.ready = false;
        this.client = null;
        this.connecting = null;
      });
      try {
        client.connect(this.connectConfig());
      } catch (err) {
        this.ready = false;
        this.connecting = null;
        reject(new SshUnreachableError(err instanceof Error ? err.message : String(err)));
      }
    });
    return this.connecting;
  }

  private async withSftp<T>(fn: (sftp: SshSftp) => Promise<T>): Promise<T> {
    await this.ensureConnected();
    const client = this.client;
    if (!client) throw new SshUnreachableError(`ssh host ${this.opts.host} is not connected`);
    const sftp = await new Promise<SshSftp>((resolve, reject) => {
      client.sftp((err, s) => (err ? reject(new SshUnreachableError(err.message)) : resolve(s)));
    });
    try {
      return await fn(sftp);
    } finally {
      sftp.end();
    }
  }

  async readFile(path: string): Promise<string> {
    return this.withSftp(
      (sftp) =>
        new Promise<string>((resolve, reject) => {
          sftp.readFile(path, (err, buf) =>
            err ? reject(new SshUnreachableError(err.message)) : resolve(buf.toString("utf8")),
          );
        }),
    );
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.withSftp(async (sftp) => {
      await this.mkdirRemote(sftp, dirnamePosix(path));
      await new Promise<void>((resolve, reject) => {
        sftp.writeFile(path, Buffer.from(content, "utf8"), (err) =>
          err ? reject(new SshUnreachableError(err.message)) : resolve(),
        );
      });
    });
  }

  async listDir(path: string): Promise<DirEntry[]> {
    return this.withSftp(
      (sftp) =>
        new Promise<DirEntry[]>((resolve, reject) => {
          sftp.readdir(path, (err, list) =>
            err ? reject(new SshUnreachableError(err.message)) : resolve(normalizeList(list)),
          );
        }),
    );
  }

  async runCommand(command: string, opts: { cwd: string; timeoutMs?: number }): Promise<CommandResult> {
    return this.execCommand(`cd ${quote(opts.cwd)} && ${command}`, opts.timeoutMs);
  }

  async git(args: string[], opts: { cwd: string }): Promise<CommandResult> {
    return this.execCommand(`cd ${quote(opts.cwd)} && git ${args.map(quote).join(" ")}`, 60_000);
  }

  private execCommand(command: string, timeoutMs = 30_000): Promise<CommandResult> {
    return this.ensureConnected().then(() => {
      const client = this.client;
      if (!client) return Promise.reject(new SshUnreachableError(`ssh host ${this.opts.host} is not connected`));
      return new Promise<CommandResult>((resolve) => {
        client.exec(command, (err, channel) => {
          if (err) {
            resolve({ exitCode: 1, stdout: "", stderr: err.message, timedOut: false });
            return;
          }
          let stdout = "";
          let stderr = "";
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            channel.close();
          }, timeoutMs);

          channel.on("data", (d: Buffer) => {
            stdout += d.toString("utf8");
          });
          channel.stderr.on("data", (d: Buffer) => {
            stderr += d.toString("utf8");
          });
          channel.on("close", (code: number | null) => {
            clearTimeout(timer);
            resolve({ exitCode: code ?? 0, stdout, stderr, timedOut });
          });
        });
      });
    });
  }

  async close(): Promise<void> {
    this.client?.end();
    this.client = null;
    this.ready = false;
    this.connecting = null;
  }

  private mkdirRemote(sftp: SshSftp, dir: string): Promise<void> {
    if (!dir || dir === "/" || dir === ".") return Promise.resolve();
    const parts = dir.split("/").filter(Boolean);
    let cur = dir.startsWith("/") ? "/" : "";
    const mkdirOne = (p: string) =>
      new Promise<void>((resolve) => {
        sftp.mkdir(p, () => resolve()); // EEXIST and other errors are non-fatal here
      });
    return (async () => {
      for (const part of parts) {
        cur = cur === "/" ? `/${part}` : cur ? `${cur}/${part}` : part;
        await mkdirOne(cur);
      }
    })();
  }
}

function dirnamePosix(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "" : p.slice(0, idx);
}
