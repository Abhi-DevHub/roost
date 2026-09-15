import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { OrchestrationEngine, WorktreeManager, GitReactor } from "../src/index.js";
import type { Event } from "@roost/contracts";

let root: string;
let repo: string;

function git(args: string[], cwd: string = repo): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "roost-git-"));
  repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(["init"]);
  git(["config", "user.email", "roost@example.com"]);
  git(["config", "user.name", "Roost"]);
  writeFileSync(join(repo, "f.txt"), "x\n");
  git(["add", "."]);
  git(["commit", "-m", "init"]);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function waitFor<T>(fn: () => T | undefined, timeoutMs = 10000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const v = fn();
      if (v !== undefined) {
        clearInterval(timer);
        resolve(v);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error("waitFor timeout"));
      }
    }, 20);
  });
}

function gitCompleted(events: Event[], threadId: string): Event | undefined {
  return events.find((e) => e.type === "thread.git.completed" && e.aggregateId === threadId);
}

describe("GitReactor", () => {
  it("commit stages and commits worktree changes, then reports ok", async () => {
    const stateDir = join(root, "state-commit");
    const worktreesDir = join(root, "worktrees-commit");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(worktreesDir, { recursive: true });

    const engine = new OrchestrationEngine({ dbPath: join(stateDir, "roost.db"), worktreesDir });
    const reactor = new GitReactor(engine);
    reactor.start();

    const projectId = randomUUID();
    const worktreeId = randomUUID();
    const threadId = randomUUID();

    await engine.dispatch({
      type: "project.create",
      projectId,
      title: "repo",
      workspaceRoot: repo,
      commandId: randomUUID(),
      createdAt: new Date().toISOString(),
    });
    const created = await engine.dispatch({
      type: "worktree.create",
      worktreeId,
      projectId,
      name: "git-task",
      baseRef: "HEAD",
      commandId: randomUUID(),
      createdAt: new Date().toISOString(),
    });
    const wtEvent = created.events.find((e) => e.type === "worktree.created");
    if (!wtEvent || wtEvent.type !== "worktree.created") throw new Error("no worktree.created");
    new WorktreeManager(repo).create(wtEvent.payload.branch, wtEvent.payload.path, wtEvent.payload.baseRef);

    await engine.dispatch({
      type: "thread.create",
      threadId,
      projectId,
      worktreeId,
      title: "git thread",
      commandId: randomUUID(),
      createdAt: new Date().toISOString(),
    });

    // Make a change in the worktree, then ask the reactor to commit it.
    writeFileSync(join(wtEvent.payload.path, "new.txt"), "hello\n");
    await engine.dispatch({
      type: "thread.git.action",
      threadId,
      action: "commit",
      message: "agent: add new.txt",
      commandId: randomUUID(),
      createdAt: new Date().toISOString(),
    });

    const completed = await waitFor(() => gitCompleted(engine.readEventsAfter(0), threadId));
    expect(completed).toBeDefined();
    if (completed && completed.type === "thread.git.completed") {
      expect(completed.payload.ok).toBe(true);
      expect(completed.payload.action).toBe("commit");
    }

    const log = git(["log", "--oneline"], wtEvent.payload.path);
    expect(log).toContain("agent: add new.txt");

    reactor.stop();
    engine.close();
  });

  it("push with no remote produces an explicit ok:false result, never a crash", async () => {
    const stateDir = join(root, "state-push");
    const worktreesDir = join(root, "worktrees-push");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(worktreesDir, { recursive: true });

    const engine = new OrchestrationEngine({ dbPath: join(stateDir, "roost.db"), worktreesDir });
    const reactor = new GitReactor(engine);
    reactor.start();

    const projectId = randomUUID();
    const worktreeId = randomUUID();
    const threadId = randomUUID();

    await engine.dispatch({
      type: "project.create",
      projectId,
      title: "repo",
      workspaceRoot: repo,
      commandId: randomUUID(),
      createdAt: new Date().toISOString(),
    });
    const created = await engine.dispatch({
      type: "worktree.create",
      worktreeId,
      projectId,
      name: "push-task",
      baseRef: "HEAD",
      commandId: randomUUID(),
      createdAt: new Date().toISOString(),
    });
    const wtEvent = created.events.find((e) => e.type === "worktree.created");
    if (!wtEvent || wtEvent.type !== "worktree.created") throw new Error("no worktree.created");
    new WorktreeManager(repo).create(wtEvent.payload.branch, wtEvent.payload.path, wtEvent.payload.baseRef);

    await engine.dispatch({
      type: "thread.create",
      threadId,
      projectId,
      worktreeId,
      title: "push thread",
      commandId: randomUUID(),
      createdAt: new Date().toISOString(),
    });

    await engine.dispatch({
      type: "thread.git.action",
      threadId,
      action: "push",
      commandId: randomUUID(),
      createdAt: new Date().toISOString(),
    });

    const completed = await waitFor(() => gitCompleted(engine.readEventsAfter(0), threadId));
    expect(completed).toBeDefined();
    if (completed && completed.type === "thread.git.completed") {
      expect(completed.payload.ok).toBe(false);
    }

    reactor.stop();
    engine.close();
  });
});
