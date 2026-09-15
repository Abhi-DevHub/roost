import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import { NativeProvider, type ProviderRuntimeEvent } from "../src/index.js";

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

function usage(): LanguageModelV4Usage {
  return {
    inputTokens: { total: 1, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  };
}

interface Step {
  deltas?: string[];
  finalText?: string;
  toolCalls?: { toolCallId: string; toolName: string; input: unknown }[];
}

/** A mock model whose `doStream` returns the Nth scripted step's stream. */
function scriptedModel(steps: Step[]): MockLanguageModelV4 {
  let i = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const s = steps[i++] ?? {};
      const parts: LanguageModelV4StreamPart[] = [];
      const texts = s.deltas ?? (s.finalText !== undefined ? [s.finalText] : []);
      texts.forEach((d, idx) => parts.push({ type: "text-delta", id: `t${idx}`, delta: d }));
      for (const tc of s.toolCalls ?? []) {
        parts.push({
          type: "tool-call",
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: JSON.stringify(tc.input),
        });
      }
      parts.push({
        type: "finish",
        usage: usage(),
        finishReason: { unified: (s.toolCalls ?? []).length > 0 ? "tool-calls" : "stop", raw: "" },
      });
      return { stream: simulateReadableStream({ chunks: parts }) };
    },
  });
}

interface TurnOpts {
  provider: NativeProvider;
  threadId: string;
  prompt: string;
  cwd: string;
  onApproval?: (e: Extract<ProviderRuntimeEvent, { type: "approval.requested" }>) => "allow" | "deny";
}

async function runTurn(opts: TurnOpts): Promise<ProviderRuntimeEvent[]> {
  const { provider, threadId, prompt, cwd, onApproval } = opts;
  const events: ProviderRuntimeEvent[] = [];
  const collector = (async () => {
    for await (const e of provider.streamEvents()) {
      events.push(e);
      if (e.type === "approval.requested" && onApproval) {
        await provider.respondToRequest(threadId, e.requestId, onApproval(e));
      }
    }
  })();
  await provider.startSession({ threadId, cwd });
  await provider.sendTurn({ threadId, turnId: randomUUID(), prompt });
  await waitFor(() => (events.some((e) => e.type === "turn.completed" || e.type === "turn.failed") ? true : undefined));
  await sleep(20);
  return events;
}

describe("NativeProvider (mock model)", () => {
  let root: string;
  let cwd: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "roost-native-"));
    cwd = join(root, "worktree");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "a.txt"), "secret contents\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("streams message.delta, runs a tool call, then completes", async () => {
    const model = scriptedModel([
      { toolCalls: [{ toolCallId: "c1", toolName: "read", input: { filePath: "a.txt" } }] },
      { deltas: ["done", "!"], finalText: "done!" },
    ]);
    const provider = new NativeProvider({ model: "mock:test", agent: "build", languageModel: model });
    const events = await runTurn({ provider, threadId: "t1", prompt: "read a.txt", cwd });

    expect(events.find((e) => e.type === "tool.started")).toMatchObject({ type: "tool.started", name: "read" });
    expect(events.find((e) => e.type === "tool.completed")).toMatchObject({
      type: "tool.completed",
      name: "read",
      ok: true,
    });

    expect(events.filter((e) => e.type === "message.delta").map((e) => (e.type === "message.delta" ? e.text : ""))).toEqual([
      "done",
      "!",
    ]);
    expect(events.some((e) => e.type === "message.completed" && e.text === "done!")).toBe(true);
    expect(events.some((e) => e.type === "turn.completed")).toBe(true);
  });

  it("returns an error tool result for an unknown tool and keeps looping", async () => {
    const model = scriptedModel([
      { toolCalls: [{ toolCallId: "c1", toolName: "noSuchTool", input: {} }] },
      { finalText: "fallback" },
    ]);
    const provider = new NativeProvider({ model: "mock:test", agent: "build", languageModel: model });
    const events = await runTurn({ provider, threadId: "t2", prompt: "hi", cwd });

    expect(events.find((e) => e.type === "tool.completed")).toMatchObject({
      type: "tool.completed",
      name: "noSuchTool",
      ok: false,
    });
    expect(events.some((e) => e.type === "turn.completed")).toBe(true);
  });

  it("ask → allow executes the tool", async () => {
    const agentsDir = join(root, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "cautious.md"),
      '---\nname: cautious\nmode: primary\npermission:\n  - tool: "*"\n    permission: allow\n  - tool: "write"\n    permission: ask\n---\nYou are cautious.\n',
    );
    const model = scriptedModel([
      { toolCalls: [{ toolCallId: "c1", toolName: "write", input: { filePath: "out.txt", content: "x" } }] },
      { finalText: "wrote it" },
    ]);
    const provider = new NativeProvider({
      model: "mock:test",
      agent: "cautious",
      agentsDir,
      languageModel: model,
    });
    const events = await runTurn({
      provider,
      threadId: "t3",
      prompt: "write out.txt",
      cwd,
      onApproval: () => "allow",
    });

    expect(events.some((e) => e.type === "approval.requested")).toBe(true);
    expect(events.find((e) => e.type === "tool.completed")).toMatchObject({
      type: "tool.completed",
      name: "write",
      ok: true,
    });
    expect(events.some((e) => e.type === "turn.completed")).toBe(true);
  });

  it("ask → deny aborts the tool with an error result", async () => {
    const agentsDir = join(root, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "cautious.md"),
      '---\nname: cautious\nmode: primary\npermission:\n  - tool: "*"\n    permission: allow\n  - tool: "write"\n    permission: ask\n---\nYou are cautious.\n',
    );
    const model = scriptedModel([
      { toolCalls: [{ toolCallId: "c1", toolName: "write", input: { filePath: "out.txt", content: "x" } }] },
      { finalText: "did not write" },
    ]);
    const provider = new NativeProvider({
      model: "mock:test",
      agent: "cautious",
      agentsDir,
      languageModel: model,
    });
    const events = await runTurn({
      provider,
      threadId: "t4",
      prompt: "write out.txt",
      cwd,
      onApproval: () => "deny",
    });

    expect(events.some((e) => e.type === "approval.requested")).toBe(true);
    expect(events.find((e) => e.type === "tool.completed")).toMatchObject({
      type: "tool.completed",
      name: "write",
      ok: false,
    });
    expect(events.some((e) => e.type === "turn.completed")).toBe(true);
  });

  it("denies a tool outright under a deny rule without prompting", async () => {
    const agentsDir = join(root, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "readonly-ish.md"),
      '---\nname: readonly-ish\nmode: primary\npermission:\n  - tool: "*"\n    permission: allow\n  - tool: "write"\n    permission: deny\n---\nNo writes.\n',
    );
    const model = scriptedModel([
      { toolCalls: [{ toolCallId: "c1", toolName: "write", input: { filePath: "out.txt", content: "x" } }] },
      { finalText: "refused" },
    ]);
    const provider = new NativeProvider({
      model: "mock:test",
      agent: "readonly-ish",
      agentsDir,
      languageModel: model,
    });
    const events = await runTurn({ provider, threadId: "t5", prompt: "write", cwd });

    expect(events.some((e) => e.type === "approval.requested")).toBe(false);
    expect(events.find((e) => e.type === "tool.completed")).toMatchObject({
      type: "tool.completed",
      name: "write",
      ok: false,
    });
  });

  it("emits turn.failed when the model throws", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("model exploded");
      },
    });
    const provider = new NativeProvider({ model: "mock:test", agent: "build", languageModel: model });
    const events = await runTurn({ provider, threadId: "t6", prompt: "hi", cwd });
    expect(events.some((e) => e.type === "turn.failed")).toBe(true);
  });

  it("registers a skill tool that loads a skill body on demand", async () => {
    const model = scriptedModel([
      { toolCalls: [{ toolCallId: "c1", toolName: "skill", input: { name: "greet" } }] },
      { finalText: "loaded" },
    ]);
    const provider = new NativeProvider({
      model: "mock:test",
      agent: "build",
      languageModel: model,
      skills: [{ name: "greet", description: "greets", body: "Say hello!", source: "x" }],
    });
    const events = await runTurn({ provider, threadId: "t7", prompt: "load greet", cwd });

    expect(events.find((e) => e.type === "tool.started")).toMatchObject({ name: "skill" });
    expect(events.find((e) => e.type === "tool.completed")).toMatchObject({ name: "skill", ok: true });
  });

  it("skill tool reports an explicit error for an unknown skill", async () => {
    const model = scriptedModel([
      { toolCalls: [{ toolCallId: "c1", toolName: "skill", input: { name: "ghost" } }] },
      { finalText: "not found" },
    ]);
    const provider = new NativeProvider({
      model: "mock:test",
      agent: "build",
      languageModel: model,
      skills: [{ name: "greet", description: "greets", body: "Say hello!", source: "x" }],
    });
    const events = await runTurn({ provider, threadId: "t8", prompt: "load ghost", cwd });

    expect(events.find((e) => e.type === "tool.completed")).toMatchObject({ name: "skill", ok: false });
  });
});
