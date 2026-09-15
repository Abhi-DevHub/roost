import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinTools, runTool, ToolError } from "../src/index.js";

let root: string;
let cwd: string;
const registry = builtinTools();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "roost-tools-"));
  cwd = join(root, "worktree");
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "a.txt"), "hello\nworld\n");
  writeFileSync(join(cwd, "src", "b.ts"), "export const x = 1;\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function run(name: string, input: unknown) {
  const tool = registry.get(name);
  if (!tool) throw new Error(`no tool ${name}`);
  return runTool(tool, input, { cwd });
}

describe("tools", () => {
  it("read returns file contents", async () => {
    const r = await run("read", { filePath: "a.txt" });
    expect(r.ok).toBe(true);
    expect(r.text).toBe("hello\nworld\n");
  });

  it("read supports offset/limit", async () => {
    const r = await run("read", { filePath: "a.txt", offset: 1, limit: 1 });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("world");
  });

  it("read reports a missing file as an error result", async () => {
    const r = await run("read", { filePath: "nope.txt" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("cannot read");
  });

  it("write creates parent dirs and writes content", async () => {
    const r = await run("write", { filePath: "deep/nested/out.txt", content: "hi" });
    expect(r.ok).toBe(true);
    expect(readFileSync(join(cwd, "deep", "nested", "out.txt"), "utf8")).toBe("hi");
  });

  it("edit replaces an exact string", async () => {
    const r = await run("edit", { filePath: "a.txt", oldString: "world", newString: "earth" });
    expect(r.ok).toBe(true);
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("hello\nearth\n");
  });

  it("edit fails when the string is missing", async () => {
    const r = await run("edit", { filePath: "a.txt", oldString: "zzz", newString: "x" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("not found");
  });

  it("edit fails when the string is ambiguous", async () => {
    writeFileSync(join(cwd, "dup.txt"), "a a a\n");
    const r = await run("edit", { filePath: "dup.txt", oldString: "a", newString: "b" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("ambiguous");
  });

  it("bash runs a command in the worktree using the platform shell", async () => {
    const cmd = process.platform === "win32" ? "Get-ChildItem a.txt | Select-Object -ExpandProperty Name" : "ls a.txt";
    const r = await run("bash", { command: cmd });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("a.txt");
  });

  it("bash reports a non-zero exit code", async () => {
    const cmd = process.platform === "win32" ? "exit 7" : "exit 7";
    const r = await run("bash", { command: cmd });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("exit code 7");
  });

  it("grep finds matching lines with file:line", async () => {
    const r = await run("grep", { pattern: "world" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("a.txt:2:");
  });

  it("grep supports an include filter", async () => {
    const r = await run("grep", { pattern: "export", include: "*.ts" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("b.ts:1:");
  });

  it("glob matches by pattern", async () => {
    const r = await run("glob", { pattern: "src/**/*.ts" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("src/b.ts");
  });

  it("ls lists directory entries with type markers", async () => {
    const r = await run("ls", { path: "." });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("a.txt");
    expect(r.text).toContain("d src");
  });

  it("invalid input returns an error result (schema validation)", async () => {
    const r = await run("read", { filePath: "" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("invalid input");
  });
});
