import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { WorktreeManager } from "../src/index.js";

let root: string;
let repo: string;
let manager: WorktreeManager;

function git(args: string[], cwd: string = repo): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "roost-wt-"));
  repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(["init"]);
  git(["config", "user.email", "roost@example.com"]);
  git(["config", "user.name", "Roost"]);
  writeFileSync(join(repo, "f.txt"), "x\n");
  git(["add", "."]);
  git(["commit", "-m", "init"]);
  manager = new WorktreeManager(repo);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("WorktreeManager", () => {
  it("creates, lists, and removes a worktree", () => {
    const branch = "roost/test";
    const path = join(root, "wt-test");
    manager.create(branch, path, "HEAD");

    const list = manager.list();
    expect(list.some((w) => w.branch === branch)).toBe(true);

    const result = manager.remove(path);
    expect(result.removed).toBe(true);
    expect(result.branchDeleted).toBe(true);

    expect(manager.list().some((w) => w.branch === branch)).toBe(false);
  });

  it("remove is a no-op when the directory is already gone", () => {
    const branch = "roost/gone";
    const path = join(root, "wt-gone");
    manager.create(branch, path, "HEAD");
    rmSync(path, { recursive: true, force: true });

    const result = manager.remove(path);
    expect(result.removed).toBe(false);
  });

  it("preserves a branch that has unmerged commits", () => {
    const branch = "roost/unmerged";
    const path = join(root, "wt-unmerged");
    manager.create(branch, path, "HEAD");

    writeFileSync(join(path, "g.txt"), "y\n");
    git(["add", "."], path);
    git(
      [
        "-c",
        "user.email=roost@example.com",
        "-c",
        "user.name=Roost",
        "commit",
        "-m",
        "wip",
      ],
      path,
    );

    const result = manager.remove(path, { force: true });
    expect(result.removed).toBe(true);
    expect(result.branchDeleted).toBe(false);
    expect(result.branchPreservedReason).toContain("unmerged");

    const branches = git(["branch"]);
    expect(branches).toContain(branch);
  });
});
