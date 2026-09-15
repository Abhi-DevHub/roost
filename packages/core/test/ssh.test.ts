import { describe, it, expect } from "vitest";
import { SshHost, SshUnreachableError } from "../src/index.js";
import type { SshClient, SshChannel, SshSftp } from "../src/ssh/index.js";

// ---------------------------------------------------------------------------
// A mock ssh2 client (no real network) exercising the SshHost providers.
// ---------------------------------------------------------------------------

class FakeSftp {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();

  readFile(path: string, cb: (err: Error | undefined, buf: Buffer) => void): void {
    const v = this.files.get(path);
    if (v === undefined) cb(new Error(`ENOENT: ${path}`));
    else cb(undefined, Buffer.from(v));
  }
  writeFile(path: string, data: Buffer, cb: (err: Error | undefined) => void): void {
    this.files.set(path, data.toString("utf8"));
    cb(undefined);
  }
  mkdir(path: string, cb: (err: Error | undefined) => void): void {
    this.dirs.add(path);
    cb(undefined);
  }
  readdir(
    path: string,
    cb: (err: Error | undefined, list: Array<{ filename: string; attrs: { isDirectory(): boolean } }>) => void,
  ): void {
    const names = new Set<string>();
    for (const f of this.files.keys()) {
      if (f.startsWith(path === "/" ? "/" : `${path}/`)) {
        names.add(f.slice(path === "/" ? 1 : path.length + 1).split("/")[0]!);
      }
    }
    for (const d of this.dirs) {
      if (d !== path && d.startsWith(path === "/" ? "/" : `${path}/`)) {
        names.add(d.slice(path === "/" ? 1 : path.length + 1).split("/")[0]!);
      }
    }
    cb(
      undefined,
      [...names].map((n) => ({
        filename: n,
        attrs: { isDirectory: () => this.dirs.has(n) || !this.files.has(`${path}/${n}`) && !this.files.has(n) },
      })),
    );
  }
  end(): void {}
}

class FakeChannel {
  stdout = "";
  stderrText = "";
  exitCode = 0;
  private dataCb: ((d: Buffer) => void) | null = null;
  private errCb: ((d: Buffer) => void) | null = null;
  private closeCb: ((code: number | null) => void) | null = null;
  readonly stderr = {
    on: (_event: string, cb: (d: Buffer) => void): void => {
      this.errCb = cb;
    },
  };

  on(event: string, cb: (arg: unknown) => void): void {
    if (event === "data") this.dataCb = cb as (d: Buffer) => void;
    else if (event === "close") this.closeCb = cb as (code: number | null) => void;
  }
  close(): void {
    this.closeCb?.(this.exitCode);
  }
  /** Drive the stream: emit stdout/stderr then close with the exit code. */
  start(): void {
    if (this.stdout) this.dataCb?.(Buffer.from(this.stdout));
    if (this.stderrText) this.errCb?.(Buffer.from(this.stderrText));
    this.closeCb?.(this.exitCode);
  }
}

class FakeClient {
  readonly sftpImpl = new FakeSftp();
  connectError: Error | null = null;
  connectCount = 0;
  execImpl: (command: string) => SshChannel = () => new FakeChannel();
  private handlers = new Map<string, Array<(arg?: unknown) => void>>();

  on(event: string, listener: (arg?: unknown) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
  }
  connect(_config: Record<string, unknown>): void {
    this.connectCount++;
    if (this.connectError) this.emit("error", this.connectError);
    else this.emit("ready");
  }
  exec(command: string, cb: (err: Error | undefined, channel: SshChannel) => void): void {
    const channel = this.execImpl(command);
    cb(undefined, channel);
    (channel as FakeChannel).start();
  }
  sftp(cb: (err: Error | undefined, sftp: SshSftp) => void): void {
    cb(undefined, this.sftpImpl);
  }
  end(): void {
    this.emit("close");
  }
  private emit(event: string, arg?: unknown): void {
    for (const cb of this.handlers.get(event) ?? []) cb(arg);
  }
}

describe("SshHost (mock ssh2)", () => {
  it("reads a file over SFTP", async () => {
    const client = new FakeClient();
    client.sftpImpl.files.set("/repo/a.txt", "hello\nworld\n");
    const host = new SshHost({ host: "h", user: "u", createClient: () => client });
    expect(await host.readFile("/repo/a.txt")).toBe("hello\nworld\n");
  });

  it("writes a file (creating parent dirs) over SFTP", async () => {
    const client = new FakeClient();
    const host = new SshHost({ host: "h", user: "u", createClient: () => client });
    await host.writeFile("/repo/deep/nested/out.txt", "hi");
    expect(client.sftpImpl.files.get("/repo/deep/nested/out.txt")).toBe("hi");
    expect(client.sftpImpl.dirs.has("/repo/deep/nested")).toBe(true);
  });

  it("lists a directory over SFTP", async () => {
    const client = new FakeClient();
    client.sftpImpl.files.set("/repo/a.txt", "x");
    client.sftpImpl.dirs.add("/repo/src");
    const host = new SshHost({ host: "h", user: "u", createClient: () => client });
    const entries = await host.listDir("/repo");
    expect(entries.map((e) => e.name).sort()).toEqual(["a.txt", "src"]);
    expect(entries.find((e) => e.name === "src")?.isDirectory).toBe(true);
  });

  it("runs a command and returns stdout + exit code", async () => {
    const client = new FakeClient();
    client.execImpl = () => {
      const c = new FakeChannel();
      c.stdout = "file.txt\n";
      c.exitCode = 0;
      return c;
    };
    const host = new SshHost({ host: "h", user: "u", createClient: () => client });
    const res = await host.runCommand("ls", { cwd: "/repo" });
    expect(res.stdout).toContain("file.txt");
    expect(res.exitCode).toBe(0);
  });

  it("runs git via the git runner", async () => {
    const client = new FakeClient();
    const seen: string[] = [];
    client.execImpl = (command) => {
      seen.push(command);
      const c = new FakeChannel();
      c.stdout = "committed\n";
      c.exitCode = 0;
      return c;
    };
    const host = new SshHost({ host: "h", user: "u", createClient: () => client });
    const res = await host.git(["commit", "-m", "it works"], { cwd: "/repo" });
    expect(res.exitCode).toBe(0);
    expect(seen[0]).toContain("cd '/repo'");
    expect(seen[0]).toContain("git");
    expect(seen[0]).toContain("it works");
  });

  it("throws SshUnreachableError when the connection is refused", async () => {
    const client = new FakeClient();
    client.connectError = new Error("connection refused");
    const host = new SshHost({ host: "h", user: "u", createClient: () => client });
    await expect(host.readFile("/x")).rejects.toThrow(SshUnreachableError);
  });

  it("reconnects after the connection drops", async () => {
    let createCount = 0;
    const clients: FakeClient[] = [];
    const make = (): FakeClient => {
      const c = new FakeClient();
      c.sftpImpl.files.set("/repo/a.txt", "1");
      createCount++;
      clients.push(c);
      return c;
    };
    const host = new SshHost({ host: "h", user: "u", createClient: make });
    await host.readFile("/repo/a.txt");
    expect(createCount).toBe(1);
    clients[0]!.end(); // simulate a dropped connection
    await host.readFile("/repo/a.txt");
    expect(createCount).toBe(2);
  });
});
