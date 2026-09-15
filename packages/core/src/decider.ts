import { join } from "node:path";
import type {
  Command,
  Event,
  ReadModel,
  Project,
  Worktree,
  Thread,
} from "@roost/contracts";

/**
 * Everything `decide` is allowed to reach for. `now` and `newId` are the only
 * injected side-effects (clock + id generator); `worktreesDir` / `branchPrefix`
 * are pure configuration. No fs, no db, no process globals.
 */
export interface DecideEnv {
  now(): string;
  newId(): string;
  worktreesDir: string;
  branchPrefix: string;
}

/** A command cannot be decided (unknown project/worktree/thread, duplicate, etc.). */
export class DecideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecideError";
  }
}

function threadEvent<T extends Event["type"]>(
  type: T,
  threadId: string,
  payload: Extract<Event, { type: T }>["payload"],
  commandId: string,
  env: DecideEnv,
): Extract<Event, { type: T }> {
  return {
    type,
    sequence: 0,
    eventId: env.newId(),
    aggregateKind: "thread",
    aggregateId: threadId,
    streamVersion: 0,
    occurredAt: env.now(),
    commandId,
    payload,
  } as Extract<Event, { type: T }>;
}

/**
 * Pure decider: `command + readModel -> events`. Throws `DecideError` when the
 * command is invalid. Never touches the database, filesystem, or clock.
 *
 * Returned events carry `sequence: 0` and `streamVersion: 0` — the event store
 * assigns the real values at append time.
 */
export function decide(command: Command, readModel: ReadModel, env: DecideEnv): Event[] {
  switch (command.type) {
    case "project.create": {
      if (readModel.projects.some((p) => p.projectId === command.projectId)) {
        throw new DecideError(`project already exists: ${command.projectId}`);
      }
      return [
        {
          type: "project.created",
          sequence: 0,
          eventId: env.newId(),
          aggregateKind: "project",
          aggregateId: command.projectId,
          streamVersion: 0,
          occurredAt: env.now(),
          commandId: command.commandId,
          payload: {
            projectId: command.projectId,
            title: command.title,
            workspaceRoot: command.workspaceRoot,
          },
        },
      ];
    }
    case "worktree.create": {
      const project = readModel.projects.find((p) => p.projectId === command.projectId);
      if (!project) {
        throw new DecideError(`unknown project: ${command.projectId}`);
      }
      const branch = planBranch(command.name, readModel, command.projectId, env.branchPrefix);
      const repoName = repoNameFromRoot(project.workspaceRoot);
      const path = worktreePath(env.worktreesDir, repoName, branch);
      return [
        {
          type: "worktree.created",
          sequence: 0,
          eventId: env.newId(),
          aggregateKind: "worktree",
          aggregateId: command.worktreeId,
          streamVersion: 0,
          occurredAt: env.now(),
          commandId: command.commandId,
          payload: {
            worktreeId: command.worktreeId,
            projectId: command.projectId,
            name: command.name,
            baseRef: command.baseRef,
            branch,
            path,
          },
        },
      ];
    }
    case "worktree.remove": {
      const worktree = readModel.worktrees.find((w) => w.worktreeId === command.worktreeId);
      if (!worktree) {
        throw new DecideError(`unknown worktree: ${command.worktreeId}`);
      }
      return [
        {
          type: "worktree.removed",
          sequence: 0,
          eventId: env.newId(),
          aggregateKind: "worktree",
          aggregateId: command.worktreeId,
          streamVersion: 0,
          occurredAt: env.now(),
          commandId: command.commandId,
          payload: { worktreeId: command.worktreeId },
        },
      ];
    }
    case "thread.create": {
      if (readModel.threads.some((t) => t.threadId === command.threadId)) {
        throw new DecideError(`thread already exists: ${command.threadId}`);
      }
      const project = readModel.projects.find((p) => p.projectId === command.projectId);
      if (!project) {
        throw new DecideError(`unknown project: ${command.projectId}`);
      }
      const worktree = readModel.worktrees.find((w) => w.worktreeId === command.worktreeId);
      if (!worktree) {
        throw new DecideError(`unknown worktree: ${command.worktreeId}`);
      }
      if (worktree.projectId !== command.projectId) {
        throw new DecideError(
          `worktree ${command.worktreeId} does not belong to project ${command.projectId}`,
        );
      }
      return [
        threadEvent(
          "thread.created",
          command.threadId,
          {
            threadId: command.threadId,
            projectId: command.projectId,
            worktreeId: command.worktreeId,
            title: command.title,
            hostId: command.hostId ?? "local",
          },
          command.commandId,
          env,
        ),
      ];
    }
    case "thread.fork": {
      if (readModel.threads.some((t) => t.threadId === command.threadId)) {
        throw new DecideError(`thread already exists: ${command.threadId}`);
      }
      const parent = readModel.threads.find((t) => t.threadId === command.parentThreadId);
      if (!parent) {
        throw new DecideError(`unknown parent thread: ${command.parentThreadId}`);
      }
      let messages = parent.messages;
      if (command.upToMessageId !== undefined) {
        const idx = parent.messages.findIndex((m) => m.id === command.upToMessageId);
        if (idx < 0) {
          throw new DecideError(
            `parent thread ${command.parentThreadId} has no message ${command.upToMessageId}`,
          );
        }
        messages = parent.messages.slice(0, idx + 1);
      }
      // Copied messages get fresh ids so the per-message primary key doesn't
      // collide with the parent thread's messages.
      messages = messages.map((m) => ({ ...m, id: env.newId() }));
      return [
        threadEvent(
          "thread.created",
          command.threadId,
          {
            threadId: command.threadId,
            projectId: parent.projectId,
            worktreeId: parent.worktreeId,
            title: command.title,
            hostId: parent.hostId ?? "local",
            parentThreadId: command.parentThreadId,
            messages,
          },
          command.commandId,
          env,
        ),
      ];
    }
    case "thread.compact": {
      requireThread(readModel, command.threadId);
      return [
        threadEvent(
          "thread.compacted",
          command.threadId,
          { threadId: command.threadId, messages: command.messages },
          command.commandId,
          env,
        ),
      ];
    }
    case "thread.turn.start": {
      const thread = readModel.threads.find((t) => t.threadId === command.threadId);
      if (!thread) {
        throw new DecideError(`unknown thread: ${command.threadId}`);
      }
      if (thread.currentTurnId !== null) {
        throw new DecideError(`thread ${command.threadId} already has a turn running`);
      }
      return [
        threadEvent(
          "thread.turn.started",
          command.threadId,
          { threadId: command.threadId, turnId: command.turnId, prompt: command.prompt },
          command.commandId,
          env,
        ),
        threadEvent(
          "thread.message.appended",
          command.threadId,
          {
            threadId: command.threadId,
            message: {
              id: env.newId(),
              role: "user",
              text: command.prompt,
              at: env.now(),
            },
          },
          command.commandId,
          env,
        ),
      ];
    }
    case "thread.turn.interrupt": {
      const thread = readModel.threads.find((t) => t.threadId === command.threadId);
      if (!thread) {
        throw new DecideError(`unknown thread: ${command.threadId}`);
      }
      if (thread.currentTurnId !== command.turnId) {
        throw new DecideError(`thread ${command.threadId} has no active turn ${command.turnId}`);
      }
      return [
        threadEvent(
          "thread.turn.interrupted",
          command.threadId,
          { threadId: command.threadId, turnId: command.turnId },
          command.commandId,
          env,
        ),
      ];
    }
    case "thread.approval.respond": {
      requireThread(readModel, command.threadId);
      return [
        threadEvent(
          "thread.approval.responded",
          command.threadId,
          { threadId: command.threadId, requestId: command.requestId, decision: command.decision },
          command.commandId,
          env,
        ),
      ];
    }
    case "thread.git.action": {
      requireThread(readModel, command.threadId);
      return [
        threadEvent(
          "thread.git.requested",
          command.threadId,
          { threadId: command.threadId, action: command.action, message: command.message ?? null },
          command.commandId,
          env,
        ),
      ];
    }
    case "thread.message.append": {
      requireThread(readModel, command.threadId);
      return [
        threadEvent(
          "thread.message.appended",
          command.threadId,
          { threadId: command.threadId, message: command.message },
          command.commandId,
          env,
        ),
      ];
    }
    case "thread.message.stream": {
      requireThread(readModel, command.threadId);
      return [
        threadEvent(
          "thread.message.delta",
          command.threadId,
          { threadId: command.threadId, messageId: command.messageId, delta: command.delta },
          command.commandId,
          env,
        ),
      ];
    }
    case "thread.turn.complete": {
      requireThread(readModel, command.threadId);
      return [
        threadEvent(
          "thread.turn.completed",
          command.threadId,
          { threadId: command.threadId, turnId: command.turnId },
          command.commandId,
          env,
        ),
      ];
    }
    case "thread.turn.fail": {
      requireThread(readModel, command.threadId);
      return [
        threadEvent(
          "thread.turn.failed",
          command.threadId,
          { threadId: command.threadId, turnId: command.turnId, error: command.error },
          command.commandId,
          env,
        ),
      ];
    }
    case "thread.session.set": {
      requireThread(readModel, command.threadId);
      return [
        threadEvent(
          "thread.session.set",
          command.threadId,
          { threadId: command.threadId, status: command.status },
          command.commandId,
          env,
        ),
      ];
    }
    case "thread.approval.request": {
      requireThread(readModel, command.threadId);
      return [
        threadEvent(
          "thread.approval.requested",
          command.threadId,
          { threadId: command.threadId, requestId: command.requestId, summary: command.summary },
          command.commandId,
          env,
        ),
      ];
    }
    case "thread.git.complete": {
      requireThread(readModel, command.threadId);
      return [
        threadEvent(
          "thread.git.completed",
          command.threadId,
          { threadId: command.threadId, action: command.action, ok: command.ok, summary: command.summary },
          command.commandId,
          env,
        ),
      ];
    }
  }
}

function requireThread(readModel: ReadModel, threadId: string): void {
  if (!readModel.threads.some((t) => t.threadId === threadId)) {
    throw new DecideError(`unknown thread: ${threadId}`);
  }
}

/** Pick `<branchPrefix>/<name>` with a bounded `-2`/`-3`… collision suffix. */
function planBranch(name: string, readModel: ReadModel, projectId: string, prefix: string): string {
  const base = `${prefix}/${name}`;
  const taken = new Set(
    readModel.worktrees.filter((w) => w.projectId === projectId).map((w) => w.branch),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; i <= 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new DecideError(`branch collision suffix exhausted for name: ${name}`);
}

/** Last path segment of a workspace root, tolerant of `/` and `\` separators. */
function repoNameFromRoot(workspaceRoot: string): string {
  const trimmed = workspaceRoot.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "repo";
}

/** `<worktreesDir>/<repoName>/<branch-dashed>` where `/` becomes `-`. */
function worktreePath(worktreesDir: string, repoName: string, branch: string): string {
  const branchDashed = branch.replace(/\//g, "-");
  return join(worktreesDir, repoName, branchDashed);
}

export const emptyReadModel = (): ReadModel => ({
  projects: [],
  worktrees: [],
  threads: [],
  snapshotSequence: 0,
});

function bump(readModel: ReadModel, event: Event): ReadModel {
  return { ...readModel, snapshotSequence: Math.max(readModel.snapshotSequence, event.sequence) };
}

/**
 * Pure projector: folds a single event into a read model, returning a new one.
 * Idempotent under replay (re-applying an already-applied event is a no-op).
 */
export function projectEvent(readModel: ReadModel, event: Event): ReadModel {
  switch (event.type) {
    case "project.created": {
      if (readModel.projects.some((p) => p.projectId === event.payload.projectId)) {
        return readModel;
      }
      const project: Project = {
        projectId: event.payload.projectId,
        title: event.payload.title,
        workspaceRoot: event.payload.workspaceRoot,
      };
      return bump(
        { ...readModel, projects: [...readModel.projects, project] },
        event,
      );
    }
    case "worktree.created": {
      if (readModel.worktrees.some((w) => w.worktreeId === event.payload.worktreeId)) {
        return readModel;
      }
      const worktree: Worktree = {
        worktreeId: event.payload.worktreeId,
        projectId: event.payload.projectId,
        name: event.payload.name,
        baseRef: event.payload.baseRef,
        branch: event.payload.branch,
        path: event.payload.path,
        createdAt: event.occurredAt,
      };
      return bump(
        { ...readModel, worktrees: [...readModel.worktrees, worktree] },
        event,
      );
    }
    case "worktree.removed": {
      return bump(
        {
          ...readModel,
          worktrees: readModel.worktrees.filter((w) => w.worktreeId !== event.payload.worktreeId),
        },
        event,
      );
    }
    case "thread.created": {
      if (readModel.threads.some((t) => t.threadId === event.payload.threadId)) {
        return readModel;
      }
      const thread: Thread = {
        threadId: event.payload.threadId,
        projectId: event.payload.projectId,
        worktreeId: event.payload.worktreeId,
        title: event.payload.title,
        hostId: event.payload.hostId ?? "local",
        parentThreadId: event.payload.parentThreadId ?? null,
        messages: event.payload.messages ?? [],
        session: { status: "idle" },
        currentTurnId: null,
        createdAt: event.occurredAt,
      };
      return bump({ ...readModel, threads: [...readModel.threads, thread] }, event);
    }
    case "thread.compacted": {
      return bump(
        {
          ...readModel,
          threads: readModel.threads.map((t) =>
            t.threadId === event.payload.threadId ? { ...t, messages: event.payload.messages } : t,
          ),
        },
        event,
      );
    }
    case "thread.turn.started": {
      return bump(
        {
          ...readModel,
          threads: readModel.threads.map((t) =>
            t.threadId === event.payload.threadId ? { ...t, currentTurnId: event.payload.turnId } : t,
          ),
        },
        event,
      );
    }
    case "thread.message.appended": {
      const { threadId, message } = event.payload;
      return bump(
        {
          ...readModel,
          threads: readModel.threads.map((t) => {
            if (t.threadId !== threadId) return t;
            if (t.messages.some((m) => m.id === message.id)) return t;
            return { ...t, messages: [...t.messages, message] };
          }),
        },
        event,
      );
    }
    case "thread.turn.completed":
    case "thread.turn.failed": {
      const threadId = event.payload.threadId;
      return bump(
        {
          ...readModel,
          threads: readModel.threads.map((t) =>
            t.threadId === threadId ? { ...t, currentTurnId: null } : t,
          ),
        },
        event,
      );
    }
    case "thread.session.set": {
      return bump(
        {
          ...readModel,
          threads: readModel.threads.map((t) =>
            t.threadId === event.payload.threadId
              ? { ...t, session: { status: event.payload.status } }
              : t,
          ),
        },
        event,
      );
    }
    // Transient events: recorded in the log, no read-model materialization.
    case "thread.turn.interrupted":
    case "thread.message.delta":
    case "thread.approval.requested":
    case "thread.approval.responded":
    case "thread.git.requested":
    case "thread.git.completed": {
      return bump(readModel, event);
    }
  }
}
