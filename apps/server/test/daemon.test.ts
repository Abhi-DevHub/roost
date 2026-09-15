import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startDaemon, type Daemon } from "../src/daemon.js";
import { FakeProvider, ProviderRegistry, type FakeScript } from "@roost/core";
import type { Command, Event, ReadModel } from "@roost/contracts";

let root: string;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function now(): string {
  return new Date().toISOString();
}

function projectCreate(projectId: string, workspaceRoot: string): Command {
  return { type: "project.create", projectId, title: "repo", workspaceRoot, commandId: randomUUID(), createdAt: now() };
}

function worktreeCreate(worktreeId: string, projectId: string, name: string): Command {
  return { type: "worktree.create", worktreeId, projectId, name, baseRef: "HEAD", commandId: randomUUID(), createdAt: now() };
}

function threadCreate(threadId: string, projectId: string, worktreeId: string): Command {
  return { type: "thread.create", threadId, projectId, worktreeId, title: "t", commandId: randomUUID(), createdAt: now() };
}

function turnStart(threadId: string, prompt: string): Command {
  return { type: "thread.turn.start", threadId, turnId: randomUUID(), prompt, commandId: randomUUID(), createdAt: now() };
}

async function dispatch(url: string, directory: string, command: Command): Promise<void> {
  const res = await fetch(`${url}/rpc/dispatch`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-roost-directory": directory },
    body: JSON.stringify({ command }),
  });
  const body = (await res.json()) as { ok: boolean; error?: string };
  if (!body.ok) throw new Error(`dispatch failed: ${body.error}`);
}

async function getState(url: string, directory: string): Promise<ReadModel> {
  const res = await fetch(`${url}/state`, { headers: { "x-roost-directory": directory } });
  return ((await res.json()) as { readModel: ReadModel }).readModel;
}

function openWs(url: string, directory: string, fromSequence: number): { ws: WebSocket; events: Event[] } {
  const events: Event[] = [];
  const ws = new WebSocket(
    `${url.replace(/^http/, "ws")}/events?fromSequence=${fromSequence}&directory=${encodeURIComponent(directory)}`,
  );
  ws.onmessage = (m) => {
    const parsed = JSON.parse(String(m.data)) as { event?: Event };
    if (parsed.event) events.push(parsed.event);
  };
  return { ws, events };
}

async function waitFor<T>(
  fn: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 10_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await sleep(20);
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "roost-daemon-"));
  process.env.ROOST_HOME = join(root, "home");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const daemons: Daemon[] = [];
async function boot(opts?: Parameters<typeof startDaemon>[0]): Promise<Daemon> {
  const d = await startDaemon({ port: 0, ...opts });
  daemons.push(d);
  return d;
}

afterAll(async () => {
  await Promise.all(daemons.map((d) => d.close()));
});

describe("Roost daemon", () => {
  it("dispatches over HTTP, streams events over WS, and /state reflects the read model", async () => {
    const dir = join(root, "proj-a");
    mkdirSync(join(dir, ".roost"), { recursive: true });
    writeFileSync(join(dir, ".roost", "config.json"), JSON.stringify({ provider: "fake" }));

    const daemon = await boot();

    const projectId = randomUUID();
    const worktreeId = randomUUID();
    const threadId = randomUUID();

    await dispatch(daemon.url, dir, projectCreate(projectId, dir));
    await dispatch(daemon.url, dir, worktreeCreate(worktreeId, projectId, "task"));
    await dispatch(daemon.url, dir, threadCreate(threadId, projectId, worktreeId));
    await dispatch(daemon.url, dir, turnStart(threadId, "hello"));

    // The turn runs to completion server-side; /state reflects it.
    const t = await waitFor(async () => {
      const model = await getState(daemon.url, dir);
      const th = model.threads.find((x) => x.threadId === threadId);
      return th && th.session.status === "idle" && th.messages.some((m) => m.role === "assistant") ? th : undefined;
    });
    expect(t.messages.map((m) => m.role)).toContain("assistant");

    const rm = await getState(daemon.url, dir);
    expect(rm.projects).toHaveLength(1);
    expect(rm.worktrees).toHaveLength(1);

    const { ws, events } = openWs(daemon.url, dir, 0);
    await waitFor(() => (events.some((e) => e.type === "thread.turn.completed") ? events : undefined));
    ws.close();
    expect(events.some((e) => e.type === "thread.turn.started")).toBe(true);
    expect(events.some((e) => e.type === "thread.message.delta")).toBe(true);
    expect(events.some((e) => e.type === "thread.turn.completed")).toBe(true);
  });

  it("replays earlier events when subscribing from a past sequence (reattach)", async () => {
    const dir = join(root, "proj-b");
    mkdirSync(dir, { recursive: true });

    const slowScript: FakeScript = async (_t, _turn, _prompt, ctx) => {
      ctx.stream(["Hello"]);
      await sleep(250);
      ctx.stream([", "]);
      await sleep(250);
      ctx.stream(["world."]);
      ctx.emit({ type: "message.completed", text: "Hello, world." });
      ctx.emit({ type: "turn.completed" });
    };

    const daemon = await boot({
      buildRegistry: () => new ProviderRegistry().register(new FakeProvider({ script: slowScript }), { default: true }),
    });

    const projectId = randomUUID();
    const worktreeId = randomUUID();
    const threadId = randomUUID();
    await dispatch(daemon.url, dir, projectCreate(projectId, dir));
    await dispatch(daemon.url, dir, worktreeCreate(worktreeId, projectId, "task"));
    await dispatch(daemon.url, dir, threadCreate(threadId, projectId, worktreeId));
    await dispatch(daemon.url, dir, turnStart(threadId, "slow hello"));

    // Client #1 attaches, sees the turn start, then disconnects mid-turn.
    const first = openWs(daemon.url, dir, 0);
    await waitFor(() => (first.events.some((e) => e.type === "thread.turn.started") ? true : undefined));
    first.ws.close();

    // The turn continues server-side; wait for completion.
    await waitFor(async () => {
      const rm = await getState(daemon.url, dir);
      const th = rm.threads.find((x) => x.threadId === threadId);
      return th && th.session.status === "idle" ? th : undefined;
    });

    // Client #2 reattaches from sequence 0: the full log replays.
    const second = openWs(daemon.url, dir, 0);
    await waitFor(() => (second.events.some((e) => e.type === "thread.turn.completed") ? second.events : undefined));
    second.ws.close();

    expect(second.events.some((e) => e.type === "thread.turn.started")).toBe(true);
    expect(second.events.some((e) => e.type === "thread.message.delta")).toBe(true);
    expect(second.events.some((e) => e.type === "thread.message.appended")).toBe(true);
    expect(second.events.some((e) => e.type === "thread.turn.completed")).toBe(true);
  });

  it("isolates engines per directory (two dirs → two read models)", async () => {
    const dirA = join(root, "proj-a2");
    const dirB = join(root, "proj-b2");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });

    const daemon = await boot({
      buildRegistry: () => new ProviderRegistry().register(new FakeProvider(), { default: true }),
    });

    const aProject = randomUUID();
    const aWorktree = randomUUID();
    const aThread = randomUUID();
    await dispatch(daemon.url, dirA, projectCreate(aProject, dirA));
    await dispatch(daemon.url, dirA, worktreeCreate(aWorktree, aProject, "task"));
    await dispatch(daemon.url, dirA, threadCreate(aThread, aProject, aWorktree));
    await dispatch(daemon.url, dirA, turnStart(aThread, "in A"));

    const bProject = randomUUID();
    await dispatch(daemon.url, dirB, projectCreate(bProject, dirB));

    const a = await getState(daemon.url, dirA);
    const b = await getState(daemon.url, dirB);

    expect(a.projects.map((p) => p.projectId)).toEqual([aProject]);
    expect(b.projects.map((p) => p.projectId)).toEqual([bProject]);
    expect(a.threads).toHaveLength(1);
    expect(b.threads).toHaveLength(0);
    expect(b.worktrees).toHaveLength(0);
  });
});
