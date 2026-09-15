import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContext } from "../src/index.js";

let root: string;
let globalFile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "roost-ctx-"));
  globalFile = join(root, "global.md");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loadContext", () => {
  it("concatenates global → parents → cwd in order", () => {
    writeFileSync(globalFile, "GLOBAL");
    const proj = join(root, "proj");
    const nested = join(proj, "sub", "deep");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(proj, "AGENTS.md"), "PROJ");
    writeFileSync(join(proj, "sub", "AGENTS.md"), "SUB");
    writeFileSync(join(nested, "AGENTS.md"), "DEEP");

    const ctx = loadContext({ cwd: nested, globalFile });
    expect(ctx.indexOf("GLOBAL")).toBeLessThan(ctx.indexOf("PROJ"));
    expect(ctx.indexOf("PROJ")).toBeLessThan(ctx.indexOf("SUB"));
    expect(ctx.indexOf("SUB")).toBeLessThan(ctx.indexOf("DEEP"));
  });

  it("returns an empty string when nothing exists", () => {
    const empty = join(root, "empty");
    mkdirSync(empty, { recursive: true });
    expect(loadContext({ cwd: empty, globalFile: join(root, "missing.md") })).toBe("");
  });

  it("skips missing intermediate files", () => {
    const proj = join(root, "p");
    mkdirSync(join(proj, "a", "b"), { recursive: true });
    writeFileSync(join(proj, "a", "b", "AGENTS.md"), "LEAF");
    const ctx = loadContext({ cwd: join(proj, "a", "b"), globalFile: join(root, "missing.md") });
    expect(ctx).toContain("LEAF");
  });
});
