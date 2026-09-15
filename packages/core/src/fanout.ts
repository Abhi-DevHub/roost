import { randomUUID } from "node:crypto";
import type { OrchestrationEngine } from "./engine.js";

// ---------------------------------------------------------------------------
// Fan-out — create N worktrees (distinct branch suffixes) + N threads, then
// start the same turn in each. Materialization is injected so the helper is
// testable without touching git.
// ---------------------------------------------------------------------------

export interface FanoutEntry {
  worktreeId: string;
  branch: string;
  path: string;
  threadId: string;
  status: "running";
}

export interface FanoutInput {
  engine: OrchestrationEngine;
  projectId: string;
  name: string;
  count: number;
  prompt: string;
  baseRef?: string;
  /** Materialize a worktree (git worktree add). Optional for tests. */
  materializeWorktree?: (entry: { branch: string; path: string; baseRef: string }) => void;
}

export class FanoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FanoutError";
  }
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Create `count` worktrees and threads for a project, start the same turn in
 * each, and return one entry per agent. Branch suffixes are planned by the
 * decider (`-2`, `-3`, …), so each worktree gets a distinct branch.
 */
export async function fanout(input: FanoutInput): Promise<FanoutEntry[]> {
  if (input.count < 1) throw new FanoutError(`count must be >= 1, got ${input.count}`);
  const project = input.engine.getReadModel().projects.find((p) => p.projectId === input.projectId);
  if (!project) throw new FanoutError(`unknown project: ${input.projectId}`);

  const baseRef = input.baseRef ?? "HEAD";
  const entries: FanoutEntry[] = [];

  for (let n = 0; n < input.count; n++) {
    const worktreeId = randomUUID();
    const created = await input.engine.dispatch({
      type: "worktree.create",
      worktreeId,
      projectId: input.projectId,
      name: input.name,
      baseRef,
      commandId: randomUUID(),
      createdAt: now(),
    });
    const wtEvent = created.events.find((e) => e.type === "worktree.created");
    if (!wtEvent || wtEvent.type !== "worktree.created") {
      throw new FanoutError("worktree.create produced no worktree.created event");
    }
    if (input.materializeWorktree) {
      input.materializeWorktree({
        branch: wtEvent.payload.branch,
        path: wtEvent.payload.path,
        baseRef,
      });
    }

    const threadId = randomUUID();
    await input.engine.dispatch({
      type: "thread.create",
      threadId,
      projectId: input.projectId,
      worktreeId,
      title: `${input.name} #${n + 1}`,
      commandId: randomUUID(),
      createdAt: now(),
    });
    await input.engine.dispatch({
      type: "thread.turn.start",
      threadId,
      turnId: randomUUID(),
      prompt: input.prompt,
      commandId: randomUUID(),
      createdAt: now(),
    });

    entries.push({
      worktreeId,
      branch: wtEvent.payload.branch,
      path: wtEvent.payload.path,
      threadId,
      status: "running",
    });
  }

  return entries;
}
