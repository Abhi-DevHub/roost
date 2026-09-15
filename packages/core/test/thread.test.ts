import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  OrchestrationEngine,
  FakeProvider,
  ProviderRegistry,
  TurnReactor,
  decide,
  projectEvent,
  emptyReadModel,
  DecideError,
  type DecideEnv,
  type FakeScript,
} from "../src/index.js";
import type { Command, ReadModel, Thread } from "@roost/contracts";

function makeEnv(): DecideEnv {
  let i = 0;
  return {
    now: () => "2024-01-01T00:00:00.000Z",
    newId: () => `id-${i++}`,
    worktreesDir: "/worktrees",
    branchPrefix: "roost",
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await sleep(10);
  }
}

interface Fixture {
  engine: OrchestrationEngine;
  reactor: TurnReactor;
  projectId: string;
  worktreeId: string;
  threadId: string;
}

/** Engine + FakeProvider + TurnReactor with a project, worktree, and thread ready. */
async function makeFixture(provider?: FakeProvider): Promise<Fixture> {
  const engine = new OrchestrationEngine({ dbPath: ":memory:", worktreesDir: "/worktrees" });
  const registry = new ProviderRegistry().register(provider ?? new FakeProvider(), { default: true });
  const reactor = new TurnReactor(engine, registry);
  reactor.start();

  const projectId = randomUUID();
  const worktreeId = randomUUID();
  const threadId = randomUUID();

  await engine.dispatch({
    type: "project.create",
    projectId,
    title: "repo",
    workspaceRoot: "/home/repo",
    commandId: randomUUID(),
    createdAt: new Date().toISOString(),
  });
  await engine.dispatch({
    type: "worktree.create",
    worktreeId,
    projectId,
    name: "task",
    baseRef: "HEAD",
    commandId: randomUUID(),
    createdAt: new Date().toISOString(),
  });
  await engine.dispatch({
    type: "thread.create",
    threadId,
    projectId,
    worktreeId,
    title: "test thread",
    commandId: randomUUID(),
    createdAt: new Date().toISOString(),
  });

  return { engine, reactor, projectId, worktreeId, threadId };
}

function turnStart(threadId: string, turnId: string, prompt: string, commandId: string): Command {
  return {
    type: "thread.turn.start",
    threadId,
    turnId,
    prompt,
    commandId,
    createdAt: new Date().toISOString(),
  };
}

function threadOf(engine: OrchestrationEngine, threadId: string): Thread | undefined {
  return engine.getReadModel().threads.find((t) => t.threadId === threadId);
}

describe("TurnReactor (FakeProvider) end-to-end", () => {
  it("create thread → start turn → streamed message + turn.completed", async () => {
    const { engine, reactor, threadId } = await makeFixture();
    try {
      const turnId = randomUUID();
      await engine.dispatch(turnStart(threadId, turnId, "hello agent", randomUUID()));

      const thread = await waitFor(() => {
        const t = threadOf(engine, threadId);
        return t && t.session.status === "idle" && t.messages.some((m) => m.role === "assistant")
          ? t
          : undefined;
      });

      const roles = thread.messages.map((m) => m.role);
      expect(roles).toContain("user");
      expect(roles).toContain("assistant");
      expect(thread.messages.find((m) => m.role === "assistant")?.text).toBe("Hello, world.");
      expect(thread.session.status).toBe("idle");

      const events = engine.readEventsAfter(0);
      expect(events.some((e) => e.type === "thread.message.appended")).toBe(true);
      expect(events.some((e) => e.type === "thread.message.delta")).toBe(true);
      expect(events.some((e) => e.type === "thread.turn.completed")).toBe(true);
      expect(events.some((e) => e.type === "thread.turn.started")).toBe(true);
    } finally {
      reactor.stop();
      engine.close();
    }
  });

  it("interrupts a turn mid-stream", async () => {
    const script: FakeScript = async (_t, _turnId, _prompt, ctx) => {
      ctx.emit({ type: "message.delta", text: "working…" });
      while (!ctx.isAborted()) await sleep(5);
    };
    const { engine, reactor, threadId } = await makeFixture(new FakeProvider({ script }));
    try {
      const turnId = randomUUID();
      await engine.dispatch(turnStart(threadId, turnId, "long task", randomUUID()));

      await waitFor(() =>
        engine.readEventsAfter(0).some((e) => e.type === "thread.message.delta") ? true : undefined,
      );

      await engine.dispatch({
        type: "thread.turn.interrupt",
        threadId,
        turnId,
        commandId: randomUUID(),
        createdAt: new Date().toISOString(),
      });

      const thread = await waitFor(() => {
        const t = threadOf(engine, threadId);
        const failed = engine.readEventsAfter(0).some((e) => e.type === "thread.turn.failed");
        return t && t.session.status === "error" && failed ? t : undefined;
      });

      expect(thread.session.status).toBe("error");
      const failedEvent = engine.readEventsAfter(0).find((e) => e.type === "thread.turn.failed");
      expect(failedEvent).toBeDefined();
    } finally {
      reactor.stop();
      engine.close();
    }
  });

  it("approval allow → turn.completed", async () => {
    const script: FakeScript = async (_t, _turnId, _prompt, ctx) => {
      ctx.emit({ type: "message.delta", text: "May I run a command?" });
      const decision = await ctx.awaitApproval("req-1", "Run Bash: rm -rf /");
      if (decision === "allow") {
        ctx.emit({ type: "message.completed", text: "done" });
        ctx.emit({ type: "turn.completed" });
      } else {
        ctx.emit({ type: "turn.failed", error: "denied by user" });
      }
    };
    const { engine, reactor, threadId } = await makeFixture(new FakeProvider({ script }));
    try {
      await engine.dispatch(turnStart(threadId, randomUUID(), "do a thing", randomUUID()));

      await waitFor(() =>
        engine.readEventsAfter(0).some((e) => e.type === "thread.approval.requested") ? true : undefined,
      );

      await engine.dispatch({
        type: "thread.approval.respond",
        threadId,
        requestId: "req-1",
        decision: "allow",
        commandId: randomUUID(),
        createdAt: new Date().toISOString(),
      });

      const thread = await waitFor(() => {
        const t = threadOf(engine, threadId);
        const done = engine.readEventsAfter(0).some((e) => e.type === "thread.turn.completed");
        return t && t.session.status === "idle" && done ? t : undefined;
      });
      expect(thread.session.status).toBe("idle");
    } finally {
      reactor.stop();
      engine.close();
    }
  });

  it("approval deny → turn.failed", async () => {
    const script: FakeScript = async (_t, _turnId, _prompt, ctx) => {
      const decision = await ctx.awaitApproval("req-2", "Run Bash: rm -rf /");
      if (decision === "allow") ctx.emit({ type: "turn.completed" });
      else ctx.emit({ type: "turn.failed", error: "denied by user" });
    };
    const { engine, reactor, threadId } = await makeFixture(new FakeProvider({ script }));
    try {
      await engine.dispatch(turnStart(threadId, randomUUID(), "danger", randomUUID()));

      await waitFor(() =>
        engine.readEventsAfter(0).some((e) => e.type === "thread.approval.requested") ? true : undefined,
      );

      await engine.dispatch({
        type: "thread.approval.respond",
        threadId,
        requestId: "req-2",
        decision: "deny",
        commandId: randomUUID(),
        createdAt: new Date().toISOString(),
      });

      const failed = await waitFor(() => {
        const t = threadOf(engine, threadId);
        const hasFailed = engine.readEventsAfter(0).some((e) => e.type === "thread.turn.failed");
        return t && t.session.status === "error" && hasFailed ? true : undefined;
      });
      expect(failed).toBe(true);
    } finally {
      reactor.stop();
      engine.close();
    }
  });
});

describe("thread.turn.start idempotent replay", () => {
  it("same commandId twice → one turn, second returns stored sequence", async () => {
    const { engine, reactor, threadId } = await makeFixture();
    try {
      const command = turnStart(threadId, randomUUID(), "hello", randomUUID());
      const first = await engine.dispatch(command);
      expect(first.sequence).toBeGreaterThan(0);

      const second = await engine.dispatch(command);
      expect(second.events).toEqual([]);
      expect(second.sequence).toBe(first.sequence);

      const started = engine.readEventsAfter(0).filter((e) => e.type === "thread.turn.started");
      expect(started).toHaveLength(1);
    } finally {
      reactor.stop();
      engine.close();
    }
  });
});

describe("decider purity for thread commands", () => {
  const baseReadModel: ReadModel = {
    projects: [{ projectId: "p1", title: "repo", workspaceRoot: "/home/repo" }],
    worktrees: [
      {
        worktreeId: "w1",
        projectId: "p1",
        name: "task",
        baseRef: "HEAD",
        branch: "roost/task",
        path: "/worktrees/repo/roost-task",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    ],
    threads: [
      {
        threadId: "t1",
        projectId: "p1",
        worktreeId: "w1",
        title: "thread",
        messages: [],
        session: { status: "idle" },
        currentTurnId: null,
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    ],
    snapshotSequence: 3,
  };

  it("thread.create rejects an unknown project", () => {
    const cmd: Command = {
      type: "thread.create",
      threadId: "t2",
      projectId: "nope",
      worktreeId: "w1",
      title: "x",
      commandId: "c",
      createdAt: "2024-01-01T00:00:00.000Z",
    };
    expect(() => decide(cmd, baseReadModel, makeEnv())).toThrow(/unknown project/);
  });

  it("thread.create rejects a worktree from another project", () => {
    const cmd: Command = {
      type: "thread.create",
      threadId: "t2",
      projectId: "p1",
      worktreeId: "other",
      title: "x",
      commandId: "c",
      createdAt: "2024-01-01T00:00:00.000Z",
    };
    expect(() => decide(cmd, baseReadModel, makeEnv())).toThrow(/unknown worktree/);
  });

  it("thread.turn.start rejects an unknown thread", () => {
    const cmd = turnStart("missing", "turn-1", "hi", "c");
    expect(() => decide(cmd, baseReadModel, makeEnv())).toThrow(/unknown thread/);
  });

  it("thread.turn.start rejects a second turn while one is running", () => {
    const running: ReadModel = {
      ...baseReadModel,
      threads: baseReadModel.threads.map((t) => ({ ...t, currentTurnId: "turn-1" })),
    };
    const cmd = turnStart("t1", "turn-2", "hi", "c");
    expect(() => decide(cmd, running, makeEnv())).toThrow(/already has a turn running/);
  });

  it("thread.turn.interrupt rejects when no active turn", () => {
    const cmd: Command = {
      type: "thread.turn.interrupt",
      threadId: "t1",
      turnId: "turn-1",
      commandId: "c",
      createdAt: "2024-01-01T00:00:00.000Z",
    };
    expect(() => decide(cmd, baseReadModel, makeEnv())).toThrow(/no active turn/);
  });

  it("thread.turn.start emits a started event and a user message", () => {
    const cmd = turnStart("t1", "turn-1", "hello", "c");
    const events = decide(cmd, baseReadModel, makeEnv());
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "thread.turn.started", aggregateKind: "thread", aggregateId: "t1" });
    expect(events[1]).toMatchObject({
      type: "thread.message.appended",
      payload: { threadId: "t1", message: { role: "user", text: "hello" } },
    });
  });

  it("projectEvent folds thread.created + message.appended idempotently", () => {
    const created = {
      type: "thread.created" as const,
      sequence: 4,
      eventId: "e4",
      aggregateKind: "thread" as const,
      aggregateId: "t2",
      streamVersion: 0,
      occurredAt: "2024-01-01T00:00:00.000Z",
      commandId: "c",
      payload: { threadId: "t2", projectId: "p1", worktreeId: "w1", title: "x" },
    };
    const withThread = projectEvent(baseReadModel, created);
    expect(withThread.threads).toHaveLength(2);

    const appended = {
      type: "thread.message.appended" as const,
      sequence: 5,
      eventId: "e5",
      aggregateKind: "thread" as const,
      aggregateId: "t2",
      streamVersion: 1,
      occurredAt: "2024-01-01T00:00:00.000Z",
      commandId: "c",
      payload: {
        threadId: "t2",
        message: { id: "m1", role: "assistant" as const, text: "hi", at: "2024-01-01T00:00:00.000Z" },
      },
    };
    const once = projectEvent(withThread, appended);
    expect(once.threads.find((t) => t.threadId === "t2")?.messages).toHaveLength(1);
    const twice = projectEvent(once, appended);
    expect(twice.threads.find((t) => t.threadId === "t2")?.messages).toHaveLength(1);
  });
});

describe("decider rejects unknown state (no silent fallback)", () => {
  it("thread.message.append for an unknown thread throws", () => {
    const cmd: Command = {
      type: "thread.message.append",
      threadId: "ghost",
      message: { id: "m", role: "assistant", text: "x", at: "2024-01-01T00:00:00.000Z" },
      commandId: "c",
      createdAt: "2024-01-01T00:00:00.000Z",
    };
    expect(() => decide(cmd, emptyReadModel(), makeEnv())).toThrow(DecideError);
  });
});
