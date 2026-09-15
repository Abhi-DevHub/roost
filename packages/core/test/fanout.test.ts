import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { OrchestrationEngine, fanout, FanoutError } from "../src/index.js";

async function makeEngine(): Promise<{ engine: OrchestrationEngine; projectId: string }> {
  const engine = new OrchestrationEngine({ dbPath: ":memory:", worktreesDir: "/worktrees" });
  const projectId = randomUUID();
  await engine.dispatch({
    type: "project.create",
    projectId,
    title: "repo",
    workspaceRoot: "/home/repo",
    commandId: randomUUID(),
    createdAt: new Date().toISOString(),
  });
  return { engine, projectId };
}

describe("fanout", () => {
  it("creates N worktrees (distinct branches) + N threads, one turn each", async () => {
    const { engine, projectId } = await makeEngine();
    try {
      const entries = await fanout({ engine, projectId, name: "exp", count: 3, prompt: "do the thing" });

      expect(entries).toHaveLength(3);
      const rm = engine.getReadModel();

      const branches = rm.worktrees.map((w) => w.branch);
      expect(new Set(branches).size).toBe(3);
      expect(branches).toContain("roost/exp");
      expect(branches).toContain("roost/exp-2");
      expect(branches).toContain("roost/exp-3");

      expect(rm.threads).toHaveLength(3);
      for (const entry of entries) {
        const thread = rm.threads.find((t) => t.threadId === entry.threadId);
        expect(thread).toBeDefined();
        expect(thread?.worktreeId).toBe(entry.worktreeId);
      }

      const turns = engine.readEventsAfter(0).filter((e) => e.type === "thread.turn.started");
      expect(turns).toHaveLength(3);
      expect(turns.every((e) => e.type === "thread.turn.started" && e.payload.prompt === "do the thing")).toBe(true);
    } finally {
      engine.close();
    }
  });

  it("rejects count < 1 and unknown project", async () => {
    const { engine, projectId } = await makeEngine();
    try {
      await expect(fanout({ engine, projectId, name: "x", count: 0, prompt: "hi" })).rejects.toThrow(FanoutError);
      await expect(fanout({ engine, projectId: "ghost", name: "x", count: 1, prompt: "hi" })).rejects.toThrow(FanoutError);
    } finally {
      engine.close();
    }
  });
});
