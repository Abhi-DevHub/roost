import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  Command,
  Event,
  ProviderRuntimeEvent,
} from "@roost/contracts";
import type { OrchestrationEngine } from "./engine.js";
import type { ProviderAdapter, ProviderRegistry } from "./provider.js";
import { WorktreeManager } from "./worktree.js";
import { LocalHost, type Host } from "./hosts.js";

const execFileAsync = promisify(execFile);

function now(): string {
  return new Date().toISOString();
}

/** Resolve the absolute worktree path a thread runs in. Throws on missing link. */
export function worktreePathFor(
  engine: OrchestrationEngine,
  threadId: string,
): string {
  const readModel = engine.getReadModel();
  const thread = readModel.threads.find((t) => t.threadId === threadId);
  if (!thread) throw new Error(`unknown thread: ${threadId}`);
  const worktree = readModel.worktrees.find((w) => w.worktreeId === thread.worktreeId);
  if (!worktree) throw new Error(`unknown worktree: ${thread.worktreeId}`);
  return worktree.path;
}

/**
 * Reactor that turns a committed `thread.turn.started` into a provider session
 * + turn, then feeds provider runtime events back into the store as commands.
 *
 * Feedback-loop guard: this reactor reacts ONLY to `thread.turn.started`,
 * `thread.turn.interrupted`, and `thread.approval.responded`. Every other event
 * — including the `thread.message.*`, `thread.turn.completed/failed`,
 * `thread.session.set`, and `thread.approval.requested` events it dispatches —
 * is terminal and ignored.
 */
export class TurnReactor {
  private readonly sessions = new Set<string>();
  private readonly streaming = new Map<string, string>(); // threadId -> messageId
  private consuming = false;
  private stopped = false;
  private readonly onEvent: (event: Event) => void;

  constructor(
    private readonly engine: OrchestrationEngine,
    private readonly registry: ProviderRegistry,
  ) {
    this.onEvent = (event: Event) => {
      void this.handle(event);
    };
  }

  start(): void {
    this.stopped = false;
    this.engine.on("event", this.onEvent);
  }

  stop(): void {
    this.stopped = true;
    this.engine.off("event", this.onEvent);
  }

  private async handle(event: Event): Promise<void> {
    if (this.stopped) return;
    switch (event.type) {
      case "thread.turn.started":
        await this.runTurn(event.payload.threadId, event.payload.turnId, event.payload.prompt);
        break;
      case "thread.turn.interrupted":
        await this.adapter().interruptTurn(event.payload.threadId, event.payload.turnId);
        break;
      case "thread.approval.responded":
        await this.adapter().respondToRequest(
          event.payload.threadId,
          event.payload.requestId,
          event.payload.decision,
        );
        break;
    }
  }

  private adapter(): ProviderAdapter {
    return this.registry.resolveDefault();
  }

  private async runTurn(threadId: string, turnId: string, prompt: string): Promise<void> {
    const adapter = this.adapter();
    this.ensureConsuming(adapter);

    if (!this.sessions.has(threadId)) {
      let cwd: string;
      try {
        cwd = worktreePathFor(this.engine, threadId);
      } catch (err) {
        await this.dispatch({
          type: "thread.turn.fail",
          threadId,
          turnId,
          error: err instanceof Error ? err.message : String(err),
          commandId: randomUUID(),
          createdAt: now(),
        });
        return;
      }
      await adapter.startSession({ threadId, cwd });
      this.sessions.add(threadId);
    }

    await this.dispatch({
      type: "thread.session.set",
      threadId,
      status: "running",
      commandId: randomUUID(),
      createdAt: now(),
    });

    await adapter.sendTurn({ threadId, prompt, turnId });
  }

  /** Single global consumer of the adapter stream, started lazily once. */
  private ensureConsuming(adapter: ProviderAdapter): void {
    if (this.consuming) return;
    this.consuming = true;
    void (async () => {
      for await (const evt of adapter.streamEvents()) {
        if (this.stopped) break;
        await this.onProviderEvent(evt);
      }
    })().catch((err) => {
      // A dead stream is not fatal; log and stop consuming so a retry is possible.
      process.stderr.write(`[TurnReactor] provider stream ended: ${String(err)}\n`);
      this.consuming = false;
    });
  }

  private async onProviderEvent(evt: ProviderRuntimeEvent): Promise<void> {
    const threadId = evt.threadId;
    switch (evt.type) {
      case "session.started":
      case "session.ended":
        return;
      case "message.delta": {
        let messageId = this.streaming.get(threadId);
        if (!messageId) {
          messageId = randomUUID();
          this.streaming.set(threadId, messageId);
        }
        await this.dispatch({
          type: "thread.message.stream",
          threadId,
          messageId,
          delta: evt.text,
          commandId: randomUUID(),
          createdAt: now(),
        });
        return;
      }
      case "message.completed": {
        const messageId = this.streaming.get(threadId) ?? randomUUID();
        this.streaming.delete(threadId);
        await this.dispatch({
          type: "thread.message.append",
          threadId,
          message: { id: messageId, role: "assistant", text: evt.text, at: now() },
          commandId: randomUUID(),
          createdAt: now(),
        });
        return;
      }
      case "tool.started":
        await this.dispatch({
          type: "thread.message.append",
          threadId,
          message: {
            id: randomUUID(),
            role: "tool",
            text: `${evt.name} ${evt.inputSummary}`,
            at: now(),
          },
          commandId: randomUUID(),
          createdAt: now(),
        });
        return;
      case "tool.completed":
        await this.dispatch({
          type: "thread.message.append",
          threadId,
          message: {
            id: randomUUID(),
            role: "tool",
            text: `${evt.name} ${evt.ok ? "completed" : "failed"}`,
            at: now(),
          },
          commandId: randomUUID(),
          createdAt: now(),
        });
        return;
      case "approval.requested": {
        await this.dispatch({
          type: "thread.approval.request",
          threadId,
          requestId: evt.requestId,
          summary: evt.summary,
          commandId: randomUUID(),
          createdAt: now(),
        });
        await this.dispatch({
          type: "thread.session.set",
          threadId,
          status: "awaiting-approval",
          commandId: randomUUID(),
          createdAt: now(),
        });
        return;
      }
      case "turn.completed": {
        const turnId = this.turnIdFor(threadId);
        await this.dispatch({
          type: "thread.turn.complete",
          threadId,
          turnId,
          commandId: randomUUID(),
          createdAt: now(),
        });
        await this.dispatch({
          type: "thread.session.set",
          threadId,
          status: "idle",
          commandId: randomUUID(),
          createdAt: now(),
        });
        return;
      }
      case "turn.failed": {
        const turnId = this.turnIdFor(threadId);
        await this.dispatch({
          type: "thread.turn.fail",
          threadId,
          turnId,
          error: evt.error,
          commandId: randomUUID(),
          createdAt: now(),
        });
        await this.dispatch({
          type: "thread.session.set",
          threadId,
          status: "error",
          commandId: randomUUID(),
          createdAt: now(),
        });
        return;
      }
    }
  }

  /** The turn currently in flight for a thread, from the read model. */
  private turnIdFor(threadId: string): string {
    return this.engine.getReadModel().threads.find((t) => t.threadId === threadId)?.currentTurnId ?? "";
  }

  private async dispatch(command: Command): Promise<void> {
    if (this.stopped) return;
    try {
      await this.engine.dispatch(command);
    } catch (err) {
      // A feedback command can be rejected if the thread was removed mid-stream.
      process.stderr.write(
        `[TurnReactor] dispatch ${command.type} failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Git reactor — commit / push / createPr in the thread's worktree.
// ---------------------------------------------------------------------------

async function run(cwd: string, cmd: string, args: string[]): Promise<{ ok: boolean; text: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    const text = `${stdout}${stderr}`.trim();
    return { ok: true, text };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const text = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || e.message || String(err);
    return { ok: false, text };
  }
}

/** Single-quote an argument for a remote POSIX shell. */
function quoteArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export class GitReactor {
  private readonly onEvent: (event: Event) => void;
  private stopped = false;

  constructor(
    private readonly engine: OrchestrationEngine,
    private readonly hostResolver?: (threadId: string) => Host,
  ) {
    this.onEvent = (event: Event) => {
      void this.handle(event);
    };
  }

  start(): void {
    this.stopped = false;
    this.engine.on("event", this.onEvent);
  }

  stop(): void {
    this.stopped = true;
    this.engine.off("event", this.onEvent);
  }

  private async handle(event: Event): Promise<void> {
    if (this.stopped) return;
    if (event.type !== "thread.git.requested") return;
    const { threadId, action, message } = event.payload;
    await this.runAction(threadId, action, message ?? undefined);
  }

  private async runAction(threadId: string, action: "commit" | "push" | "createPr", message?: string): Promise<void> {
    let cwd: string;
    try {
      cwd = worktreePathFor(this.engine, threadId);
    } catch (err) {
      await this.complete(threadId, action, false, err instanceof Error ? err.message : String(err));
      return;
    }

    const host = this.hostResolver?.(threadId) ?? new LocalHost();
    const runner = async (cmd: string, args: string[]): Promise<{ ok: boolean; text: string }> => {
      if (host.kind === "local") return run(cwd, cmd, args);
      const res = cmd === "git"
        ? await host.git(args, { cwd })
        : await host.runCommand(`${cmd} ${args.map(quoteArg).join(" ")}`, { cwd });
      const text = `${res.stdout}${res.stderr}`.trim();
      return { ok: res.exitCode === 0, text };
    };

    let ok: boolean;
    let summary: string;

    if (action === "commit") {
      const msg = message ?? "Roost: agent change";
      const add = await runner("git", ["add", "-A"]);
      if (!add.ok) {
        ok = false;
        summary = add.text;
      } else {
        const commit = await runner("git", ["commit", "-m", msg]);
        ok = commit.ok;
        summary = commit.ok
          ? commit.text || `committed`
          : commit.text; // e.g. "nothing to commit, working tree clean"
      }
    } else if (action === "push") {
      const push = await runner("git", ["push", "-u", "origin", "HEAD"]);
      ok = push.ok;
      summary = push.text;
    } else {
      const branch = this.engine.getReadModel().worktrees.find((w) => w.path === cwd)?.branch;
      const title = message ?? "Roost: agent change";
      const args = ["pr", "create", "--head", branch ?? "HEAD", "--title", title];
      const pr = await runner("gh", args);
      ok = pr.ok;
      summary = pr.text;
    }

    await this.complete(threadId, action, ok, summary);
  }

  private async complete(
    threadId: string,
    action: "commit" | "push" | "createPr",
    ok: boolean,
    summary: string,
  ): Promise<void> {
    if (this.stopped) return;
    const command: Command = {
      type: "thread.git.complete",
      threadId,
      action,
      ok,
      summary,
      commandId: randomUUID(),
      createdAt: now(),
    };
    try {
      await this.engine.dispatch({
        type: "thread.message.append",
        threadId,
        message: {
          id: randomUUID(),
          role: "system",
          text: `git ${action}: ${ok ? "ok" : "failed"} — ${summary}`,
          at: now(),
        },
        commandId: randomUUID(),
        createdAt: now(),
      });
      await this.engine.dispatch(command);
    } catch (err) {
      process.stderr.write(
        `[GitReactor] dispatch failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Worktree reactor — materialize `worktree.created` / `worktree.removed` on
// disk via `git worktree`. The daemon owns this so the CLI stays a thin client.
// ---------------------------------------------------------------------------

export class WorktreeReactor {
  private readonly onEvent: (event: Event) => void;
  private stopped = false;
  private readonly index = new Map<string, { path: string; workspaceRoot: string }>();

  constructor(private readonly engine: OrchestrationEngine) {
    this.onEvent = (event: Event) => {
      void this.handle(event);
    };
  }

  start(): void {
    this.stopped = false;
    // Seed from the read model so a `remove` after a daemon restart still resolves.
    const rm = this.engine.getReadModel();
    for (const w of rm.worktrees) {
      const p = rm.projects.find((x) => x.projectId === w.projectId);
      if (p) this.index.set(w.worktreeId, { path: w.path, workspaceRoot: p.workspaceRoot });
    }
    this.engine.on("event", this.onEvent);
  }

  stop(): void {
    this.stopped = true;
    this.engine.off("event", this.onEvent);
  }

  private async handle(event: Event): Promise<void> {
    if (this.stopped) return;
    if (event.type === "worktree.created") {
      const project = this.engine.getReadModel().projects.find(
        (p) => p.projectId === event.payload.projectId,
      );
      if (!project) return;
      this.index.set(event.payload.worktreeId, {
        path: event.payload.path,
        workspaceRoot: project.workspaceRoot,
      });
      try {
        new WorktreeManager(project.workspaceRoot).create(
          event.payload.branch,
          event.payload.path,
          event.payload.baseRef,
        );
      } catch (err) {
        process.stderr.write(
          `[WorktreeReactor] materialize failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    } else if (event.type === "worktree.removed") {
      const info = this.index.get(event.payload.worktreeId);
      if (!info) return;
      this.index.delete(event.payload.worktreeId);
      try {
        new WorktreeManager(info.workspaceRoot).remove(info.path);
      } catch (err) {
        process.stderr.write(
          `[WorktreeReactor] remove failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }
}
