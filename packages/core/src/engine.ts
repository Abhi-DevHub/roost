import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Command, CommandReceipt, Event, ReadModel } from "@roost/contracts";
import { EventStore } from "./store.js";
import { decide, emptyReadModel, projectEvent, type DecideEnv } from "./decider.js";

/**
 * The surface clients program against, whether the orchestrator runs
 * in-process (`OrchestrationEngine`) or behind the daemon (`DaemonClient`).
 */
export interface RoostEngine {
  getReadModel(): ReadModel;
  dispatch(command: Command): Promise<{ sequence: number }>;
  on(event: "event", listener: (event: Event) => void): void;
  off(event: "event", listener: (event: Event) => void): void;
  close(): void;
}

export interface EngineOptions {
  /** Path to the SQLite file. Parent directories are not created by the engine. */
  dbPath: string;
  /** Absolute directory under which worktrees are materialized. */
  worktreesDir: string;
  /** Branch prefix for planned worktree branches. Defaults to `roost`. */
  branchPrefix?: string;
  /** Injectable clock; defaults to the system clock. */
  now?: () => string;
  /** Injectable id generator; defaults to `crypto.randomUUID`. */
  newId?: () => string;
}

export interface DispatchResult {
  sequence: number;
  events: Event[];
}

/** The same `commandId` was reused for a different aggregate. */
export class CommandConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandConflictError";
  }
}

/** The command was previously rejected; carries the stored receipt. */
export class CommandRejectedError extends Error {
  readonly receipt: CommandReceipt;

  constructor(receipt: CommandReceipt) {
    super(receipt.error ?? `command ${receipt.commandId} was rejected`);
    this.name = "CommandRejectedError";
    this.receipt = receipt;
  }
}

function aggregateOf(command: Command): { aggregateKind: string; aggregateId: string } {
  switch (command.type) {
    case "project.create":
      return { aggregateKind: "project", aggregateId: command.projectId };
    case "worktree.create":
    case "worktree.remove":
      return { aggregateKind: "worktree", aggregateId: command.worktreeId };
    case "thread.create":
    case "thread.fork":
    case "thread.compact":
    case "thread.turn.start":
    case "thread.turn.interrupt":
    case "thread.approval.respond":
    case "thread.git.action":
    case "thread.message.append":
    case "thread.message.stream":
    case "thread.turn.complete":
    case "thread.turn.fail":
    case "thread.session.set":
    case "thread.approval.request":
    case "thread.git.complete":
      return { aggregateKind: "thread", aggregateId: command.threadId };
  }
}

/**
 * Event-sourced orchestrator: an unbounded in-memory queue drained by a single
 * worker. `dispatch` is idempotent on `commandId`; events, projections, and the
 * receipt are committed in one transaction, and events are emitted only after
 * commit (post-commit subscriber seam).
 */
export class OrchestrationEngine extends EventEmitter {
  private readonly store: EventStore;
  private readModel: ReadModel;
  private readonly env: DecideEnv;
  private queue: (() => void)[] = [];
  private working = false;

  constructor(opts: EngineOptions) {
    super();
    this.store = new EventStore(opts.dbPath);
    this.readModel = this.store.loadReadModel();
    this.env = {
      now: opts.now ?? (() => new Date().toISOString()),
      newId: opts.newId ?? (() => randomUUID()),
      worktreesDir: opts.worktreesDir,
      branchPrefix: opts.branchPrefix ?? "roost",
    };
  }

  getReadModel(): ReadModel {
    return this.readModel;
  }

  readEventsAfter(sequence: number): Event[] {
    return this.store.readAfter(sequence);
  }

  getReceipt(commandId: string): CommandReceipt | undefined {
    return this.store.getReceipt(commandId);
  }

  close(): void {
    this.store.close();
  }

  dispatch(command: Command): Promise<DispatchResult> {
    return new Promise<DispatchResult>((resolve, reject) => {
      this.queue.push(() => {
        try {
          resolve(this.process(command));
        } catch (err) {
          reject(err);
        }
      });
      this.pump();
    });
  }

  private pump(): void {
    if (this.working) return;
    const next = this.queue.shift();
    if (!next) return;
    this.working = true;
    try {
      next();
    } finally {
      this.working = false;
      if (this.queue.length > 0) this.pump();
    }
  }

  private process(command: Command): DispatchResult {
    const { aggregateKind, aggregateId } = aggregateOf(command);

    // 1. Idempotency / conflict check on the receipt.
    const existing = this.store.getReceipt(command.commandId);
    if (existing) {
      if (existing.aggregateKind !== aggregateKind || existing.aggregateId !== aggregateId) {
        throw new CommandConflictError(
          `commandId ${command.commandId} was already used for aggregate ${existing.aggregateKind}:${existing.aggregateId}`,
        );
      }
      if (existing.status === "accepted") {
        // Already applied: return the stored result sequence, emit nothing.
        return { sequence: existing.resultSequence, events: [] };
      }
      throw new CommandRejectedError(existing);
    }

    // 2. Decide (pure). A rejected command still writes a receipt.
    let events: Event[];
    try {
      events = decide(command, this.readModel, this.env);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.writeRejectedReceipt(command, aggregateKind, aggregateId, message);
      throw err;
    }

    // 3. Atomic commit: events + projections + receipt.
    const committed = this.commit(command, aggregateKind, aggregateId, events);

    // 4. Publish after commit.
    for (const event of committed) {
      this.emit("event", event);
    }

    return { sequence: committed[committed.length - 1]!.sequence, events: committed };
  }

  private commit(
    command: Command,
    aggregateKind: string,
    aggregateId: string,
    draftEvents: Event[],
  ): Event[] {
    const committed: Event[] = [];
    this.store.transaction(() => {
      for (const draft of draftEvents) {
        const event = this.store.append(draft);
        committed.push(event);
        this.store.applyProjection(event);
        this.readModel = projectEvent(this.readModel, event);
      }
      this.store.updateProjectionState(this.readModel.snapshotSequence);
      this.store.upsertReceipt({
        commandId: command.commandId,
        aggregateKind,
        aggregateId,
        acceptedAt: this.env.now(),
        resultSequence: this.readModel.snapshotSequence,
        status: "accepted",
        error: null,
      });
    });
    return committed;
  }

  private writeRejectedReceipt(
    command: Command,
    aggregateKind: string,
    aggregateId: string,
    error: string,
  ): void {
    this.store.transaction(() => {
      this.store.upsertReceipt({
        commandId: command.commandId,
        aggregateKind,
        aggregateId,
        acceptedAt: this.env.now(),
        resultSequence: this.readModel.snapshotSequence,
        status: "rejected",
        error,
      });
    });
  }
}

export { emptyReadModel };
