import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  OrchestrationEngine,
  compactMessages,
  splitMessages,
  truncateHandoff,
  estimateTokens,
} from "../src/index.js";
import type { Message } from "@roost/contracts";

function msg(id: string, role: Message["role"], text: string): Message {
  return { id, role, text, at: "2024-01-01T00:00:00.000Z" };
}

const longText = (n: number): string => "x".repeat(n);

describe("estimateTokens", () => {
  it("is ~4 chars per token, bounded below at 1", () => {
    expect(estimateTokens("")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcdefgh")).toBe(2);
  });
});

describe("splitMessages", () => {
  it("keeps recent messages and never drops the last user message", () => {
    // 6 long messages; last message is assistant, last USER message is index 4.
    const messages = [
      msg("m1", "user", longText(400)),
      msg("m2", "assistant", longText(400)),
      msg("m3", "user", longText(400)),
      msg("m4", "assistant", longText(400)),
      msg("m5", "user", longText(400)),
      msg("m6", "assistant", longText(400)),
    ];
    // keepTokens budget fits only a couple of messages (~100 tokens each).
    const { older, kept } = splitMessages(messages, { maxTokens: 10000, keepTokens: 250 });

    expect(kept.map((m) => m.id)).toContain("m5"); // last user message promoted
    expect(kept[kept.length - 1]!.id).toBe("m6"); // most recent stays
    expect(older.map((m) => m.id)).not.toContain("m5");
    expect(kept.length).toBeLessThan(messages.length);
  });
});

describe("compactMessages", () => {
  it("returns null when under the threshold", async () => {
    const messages = [msg("m1", "user", "short"), msg("m2", "assistant", "short")];
    const result = await compactMessages(messages, { maxTokens: 1000, keepTokens: 500 });
    expect(result).toBeNull();
  });

  it("summarizes older messages and keeps the last user message", async () => {
    const messages = [
      msg("m1", "user", longText(800)),
      msg("m2", "assistant", longText(800)),
      msg("m3", "user", "final user question"),
      msg("m4", "assistant", longText(800)),
    ];
    const result = await compactMessages(messages, {
      maxTokens: 200,
      keepTokens: 50,
      summarize: async (older) => `SUMMARY(${older.length} messages)`,
    });
    expect(result).not.toBeNull();
    const list = result!;
    expect(list[0]).toMatchObject({ role: "system", text: "SUMMARY(2 messages)" });
    // The last user message must survive.
    expect(list.some((m) => m.role === "user" && m.text === "final user question")).toBe(true);
    // Older, summarized messages are gone from the kept tail.
    expect(list.some((m) => m.id === "m1")).toBe(false);
  });

  it("falls back to deterministic truncation with a marker when no summarizer", async () => {
    const messages = [
      msg("m1", "user", longText(800)),
      msg("m2", "assistant", longText(800)),
      msg("m3", "assistant", longText(800)),
      msg("m4", "user", "final question"),
    ];
    const result = await compactMessages(messages, { maxTokens: 100, keepTokens: 10 });
    expect(result).not.toBeNull();
    expect(result![0]!.role).toBe("system");
    expect(result![0]!.text).toContain("[compacted");
    expect(result!.some((m) => m.role === "user" && m.text === "final question")).toBe(true);
  });
});

describe("truncateHandoff", () => {
  it("marks compaction and includes role summary", () => {
    const handoff = truncateHandoff([msg("m1", "user", "hi"), msg("m2", "assistant", "yo")]);
    expect(handoff).toContain("[compacted 2 message(s): user,assistant]");
  });
});

describe("thread.compact command", () => {
  it("replaces the thread's messages with the handoff + kept list", async () => {
    const engine = new OrchestrationEngine({ dbPath: ":memory:", worktreesDir: "/wt" });
    const projectId = randomUUID();
    const worktreeId = randomUUID();
    const threadId = randomUUID();
    const at = "2024-01-01T00:00:00.000Z";
    await engine.dispatch({
      type: "project.create",
      projectId,
      title: "repo",
      workspaceRoot: "/home/repo",
      commandId: randomUUID(),
      createdAt: at,
    });
    await engine.dispatch({
      type: "worktree.create",
      worktreeId,
      projectId,
      name: "task",
      baseRef: "HEAD",
      commandId: randomUUID(),
      createdAt: at,
    });
    await engine.dispatch({
      type: "thread.create",
      threadId,
      projectId,
      worktreeId,
      title: "chat",
      commandId: randomUUID(),
      createdAt: at,
    });
    await engine.dispatch({
      type: "thread.message.append",
      threadId,
      message: msg("m1", "user", "question"),
      commandId: randomUUID(),
      createdAt: at,
    });

    const handoff = msg("handoff-1", "system", "[compacted 1 message(s)]");
    await engine.dispatch({
      type: "thread.compact",
      threadId,
      messages: [handoff],
      commandId: randomUUID(),
      createdAt: at,
    });

    const t = engine.getReadModel().threads.find((x) => x.threadId === threadId);
    expect(t?.messages.map((m) => m.id)).toEqual(["handoff-1"]);

    const events = engine.readEventsAfter(0);
    expect(events.some((e) => e.type === "thread.compacted")).toBe(true);
    engine.close();
  });
});
