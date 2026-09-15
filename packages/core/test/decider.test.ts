import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  decide,
  projectEvent,
  emptyReadModel,
  DecideError,
  OrchestrationEngine,
  type DecideEnv,
} from "../src/index.js";
import type { Command, ReadModel } from "@roost/contracts";

function makeEnv(): DecideEnv {
  let i = 0;
  return {
    now: () => "2024-01-01T00:00:00.000Z",
    newId: () => `id-${i++}`,
    worktreesDir: "/worktrees",
    branchPrefix: "roost",
  };
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

const projectCreate: Command = {
  type: "project.create",
  projectId: "p1",
  title: "repo",
  workspaceRoot: "/home/repo",
  commandId: "c1",
  createdAt: "2024-01-01T00:00:00.000Z",
};

describe("decider", () => {
  it("is pure: same input → same output, no mutation of the read model", () => {
    const readModel = emptyReadModel();
    const before = clone(readModel);

    const a = decide(projectCreate, readModel, makeEnv());
    const b = decide(projectCreate, readModel, makeEnv());

    expect(a).toEqual(b);
    expect(readModel).toEqual(before);
    expect(a).toHaveLength(1);
    expect(a[0]!.type).toBe("project.created");
  });

  it("emits project.created", () => {
    const events = decide(projectCreate, emptyReadModel(), makeEnv());
    expect(events[0]).toMatchObject({
      type: "project.created",
      aggregateKind: "project",
      aggregateId: "p1",
      payload: { projectId: "p1", title: "repo", workspaceRoot: "/home/repo" },
    });
  });

  it("rejects a duplicate project", () => {
    const readModel = projectEvent(emptyReadModel(), {
      type: "project.created",
      sequence: 1,
      eventId: "e1",
      aggregateKind: "project",
      aggregateId: "p1",
      streamVersion: 0,
      occurredAt: "2024-01-01T00:00:00.000Z",
      commandId: "c1",
      payload: { projectId: "p1", title: "repo", workspaceRoot: "/home/repo" },
    });
    expect(() => decide(projectCreate, readModel, makeEnv())).toThrow(DecideError);
  });

  it("rejects a worktree.create for an unknown project", () => {
    const cmd: Command = {
      type: "worktree.create",
      worktreeId: "w1",
      projectId: "nope",
      name: "fix",
      baseRef: "HEAD",
      commandId: "c2",
      createdAt: "2024-01-01T00:00:00.000Z",
    };
    expect(() => decide(cmd, emptyReadModel(), makeEnv())).toThrow(/unknown project/);
  });

  it("plans a collision-suffixed branch and dashed path", () => {
    const base: ReadModel = {
      projects: [{ projectId: "p1", title: "repo", workspaceRoot: "/home/repo" }],
      worktrees: [
        {
          worktreeId: "w1",
          projectId: "p1",
          name: "fix",
          baseRef: "HEAD",
          branch: "roost/fix",
          path: "/worktrees/repo/roost-fix",
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      snapshotSequence: 1,
    };
    const cmd: Command = {
      type: "worktree.create",
      worktreeId: "w2",
      projectId: "p1",
      name: "fix",
      baseRef: "HEAD",
      commandId: "c3",
      createdAt: "2024-01-01T00:00:00.000Z",
    };
    const events = decide(cmd, base, makeEnv());
    expect(events[0]).toMatchObject({
      type: "worktree.created",
      payload: { branch: "roost/fix-2", path: join("/worktrees", "repo", "roost-fix-2") },
    });
  });
});

describe("projectEvent", () => {
  it("reduces events into a read model and is idempotent under replay", () => {
    const event = {
      type: "project.created" as const,
      sequence: 1,
      eventId: "e1",
      aggregateKind: "project" as const,
      aggregateId: "p1",
      streamVersion: 0,
      occurredAt: "2024-01-01T00:00:00.000Z",
      commandId: "c1",
      payload: { projectId: "p1", title: "repo", workspaceRoot: "/home/repo" },
    };
    const once = projectEvent(emptyReadModel(), event);
    expect(once.projects).toHaveLength(1);
    expect(once.snapshotSequence).toBe(1);
    const twice = projectEvent(once, event);
    expect(twice.projects).toHaveLength(1);
  });
});

describe("OrchestrationEngine idempotency", () => {
  it("same commandId twice → one event, second returns the stored sequence", async () => {
    const engine = new OrchestrationEngine({ dbPath: ":memory:", worktreesDir: "/worktrees" });
    const first = await engine.dispatch(projectCreate);
    expect(first.sequence).toBe(1);

    const second = await engine.dispatch(projectCreate);
    expect(second.sequence).toBe(1);
    expect(second.events).toEqual([]);

    expect(engine.getReadModel().projects).toHaveLength(1);
    engine.close();
  });

  it("rejections write a receipt and are rethrown on replay", async () => {
    const engine = new OrchestrationEngine({ dbPath: ":memory:", worktreesDir: "/worktrees" });
    const cmd: Command = {
      type: "worktree.create",
      worktreeId: "w1",
      projectId: "nope",
      name: "fix",
      baseRef: "HEAD",
      commandId: "c-bad",
      createdAt: "2024-01-01T00:00:00.000Z",
    };
    await expect(engine.dispatch(cmd)).rejects.toThrow(/unknown project/);
    const receipt = engine.getReceipt(cmd.commandId);
    expect(receipt?.status).toBe("rejected");
    expect(receipt?.error).toContain("unknown project");

    await expect(engine.dispatch(cmd)).rejects.toThrow(/unknown project/);
    engine.close();
  });
});
