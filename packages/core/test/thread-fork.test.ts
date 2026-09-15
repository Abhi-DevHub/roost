import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { OrchestrationEngine } from "../src/index.js";

const now = () => new Date().toISOString();

// Windows: better-sqlite3 keeps the -shm file memory-mapped in the vitest
// worker after close, so directory removal fails with EPERM. Tolerate it.
function safeRm(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") throw err;
  }
}

async function makeThread(engine: OrchestrationEngine): Promise<{ threadId: string; worktreeId: string }> {
  const projectId = randomUUID();
  const worktreeId = randomUUID();
  const threadId = randomUUID();
  await engine.dispatch({
    type: "project.create",
    projectId,
    title: "repo",
    workspaceRoot: "/home/repo",
    commandId: randomUUID(),
    createdAt: now(),
  });
  await engine.dispatch({
    type: "worktree.create",
    worktreeId,
    projectId,
    name: "task",
    baseRef: "HEAD",
    commandId: randomUUID(),
    createdAt: now(),
  });
  await engine.dispatch({
    type: "thread.create",
    threadId,
    projectId,
    worktreeId,
    title: "parent",
    commandId: randomUUID(),
    createdAt: now(),
  });
  return { threadId, worktreeId };
}

function append(engine: OrchestrationEngine, threadId: string, id: string, role: "user" | "assistant", text: string): Promise<void> {
  return engine.dispatch({
    type: "thread.message.append",
    threadId,
    message: { id, role, text, at: now() },
    commandId: randomUUID(),
    createdAt: now(),
  }).then(() => undefined);
}

describe("thread.fork", () => {
  it("clones a thread (messages + worktree) and records lineage", async () => {
    const engine = new OrchestrationEngine({ dbPath: ":memory:", worktreesDir: "/worktrees" });
    try {
      const { threadId, worktreeId } = await makeThread(engine);
      await append(engine, threadId, "m1", "user", "question");
      await append(engine, threadId, "m2", "assistant", "answer");
      await append(engine, threadId, "m3", "user", "follow-up");

      const forkId = randomUUID();
      await engine.dispatch({
        type: "thread.fork",
        threadId: forkId,
        parentThreadId: threadId,
        title: "fork",
        upToMessageId: "m2",
        commandId: randomUUID(),
        createdAt: now(),
      });

      const rm = engine.getReadModel();
      const fork = rm.threads.find((t) => t.threadId === forkId);
      expect(fork).toBeDefined();
      expect(fork?.parentThreadId).toBe(threadId);
      expect(fork?.worktreeId).toBe(worktreeId);
      expect(fork?.messages.map((m) => m.text)).toEqual(["question", "answer"]);

      const fork2 = randomUUID();
      await engine.dispatch({
        type: "thread.fork",
        threadId: fork2,
        parentThreadId: threadId,
        title: "fork-all",
        commandId: randomUUID(),
        createdAt: now(),
      });
      const rm2 = engine.getReadModel();
      const all = rm2.threads.find((t) => t.threadId === fork2);
      expect(all?.messages.map((m) => m.text)).toEqual(["question", "answer", "follow-up"]);
    } finally {
      engine.close();
    }
  });

  it("rejects an unknown parent thread and an unknown up-to message", async () => {
    const engine = new OrchestrationEngine({ dbPath: ":memory:", worktreesDir: "/worktrees" });
    try {
      const { threadId } = await makeThread(engine);
      await append(engine, threadId, "m1", "user", "hi");
      await expect(
        engine.dispatch({
          type: "thread.fork",
          threadId: randomUUID(),
          parentThreadId: "ghost",
          title: "x",
          commandId: randomUUID(),
          createdAt: now(),
        }),
      ).rejects.toThrow(/unknown parent thread/);
      await expect(
        engine.dispatch({
          type: "thread.fork",
          threadId: randomUUID(),
          parentThreadId: threadId,
          title: "x",
          upToMessageId: "missing",
          commandId: randomUUID(),
          createdAt: now(),
        }),
      ).rejects.toThrow(/has no message missing/);
    } finally {
      engine.close();
    }
  });

  it("persists parent lineage across reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roost-fork-"));
    const dbPath = join(dir, "roost.db");
    try {
      const e1 = new OrchestrationEngine({ dbPath, worktreesDir: "/worktrees" });
      const { threadId } = await makeThread(e1);
      await append(e1, threadId, "m1", "user", "hi");
      const forkId = randomUUID();
      await e1.dispatch({
        type: "thread.fork",
        threadId: forkId,
        parentThreadId: threadId,
        title: "fork",
        commandId: randomUUID(),
        createdAt: now(),
      });
      e1.close();

      const e2 = new OrchestrationEngine({ dbPath, worktreesDir: "/worktrees" });
      const fork = e2.getReadModel().threads.find((t) => t.threadId === forkId);
      expect(fork?.parentThreadId).toBe(threadId);
      expect(fork?.messages.map((m) => m.text)).toEqual(["hi"]);
      e2.close();
    } finally {
      safeRm(dir);
    }
  });
});
