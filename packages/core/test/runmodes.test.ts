import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { OrchestrationEngine, FakeProvider, ProviderRegistry, TurnReactor, runTurnAndWait, formatEventLine } from "../src/index.js";
import { SubscribeEventSchema, type Event } from "@roost/contracts";

const now = () => new Date().toISOString();

async function makeFixture(): Promise<{
  engine: OrchestrationEngine;
  reactor: TurnReactor;
  threadId: string;
}> {
  const engine = new OrchestrationEngine({ dbPath: ":memory:", worktreesDir: "/worktrees" });
  const registry = new ProviderRegistry().register(new FakeProvider(), { default: true });
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
    title: "chat",
    commandId: randomUUID(),
    createdAt: now(),
  });
  return { engine, reactor, threadId };
}

describe("runTurnAndWait (non-interactive run mode)", () => {
  it("drives a turn to completion and streams committed events", async () => {
    const { engine, reactor, threadId } = await makeFixture();
    try {
      const events: Event[] = [];
      const result = await runTurnAndWait({
        engine,
        threadId,
        prompt: "hello",
        onEvent: (e) => events.push(e),
      });

      expect(result.ok).toBe(true);
      expect(events.some((e) => e.type === "thread.turn.started")).toBe(true);
      expect(events.some((e) => e.type === "thread.message.appended")).toBe(true);
      expect(events.some((e) => e.type === "thread.turn.completed")).toBe(true);
    } finally {
      reactor.stop();
      engine.close();
    }
  });

  it("formatEventLine produces a valid { event } JSONL line", async () => {
    const { engine, reactor, threadId } = await makeFixture();
    try {
      const events: Event[] = [];
      await runTurnAndWait({ engine, threadId, prompt: "hi", onEvent: (e) => events.push(e) });

      for (const event of events) {
        const parsed = JSON.parse(formatEventLine(event));
        expect(parsed).toHaveProperty("event");
        expect(SubscribeEventSchema.parse(parsed).event).toEqual(event);
      }
    } finally {
      reactor.stop();
      engine.close();
    }
  });
});
