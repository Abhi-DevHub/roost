import Database from "better-sqlite3";
import {
  CommandReceiptSchema,
  EventSchema,
  type CommandReceipt,
  type Event,
  type MessageRole,
  type ReadModel,
  type SessionStatus,
} from "@roost/contracts";

type DB = InstanceType<typeof Database>;

/** Ordered migrations; `version = index + 1`. */
const MIGRATIONS: string[] = [
  // v1 — event log (source of truth) + receipts + projections + projection state.
  `
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    aggregate_kind TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    stream_version INTEGER NOT NULL,
    type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    command_id TEXT,
    causation_event_id TEXT,
    payload_json TEXT NOT NULL,
    UNIQUE (aggregate_kind, stream_id, stream_version)
  );

  CREATE TABLE command_receipts (
    command_id TEXT PRIMARY KEY,
    aggregate_kind TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    accepted_at TEXT NOT NULL,
    result_sequence INTEGER NOT NULL,
    status TEXT NOT NULL,
    error TEXT
  );

  CREATE TABLE projects (
    project_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    workspace_root TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE worktrees (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    branch TEXT NOT NULL,
    path TEXT NOT NULL,
    base_ref TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE projection_state (
    projector TEXT PRIMARY KEY,
    last_applied_sequence INTEGER,
    updated_at TEXT
  );
  `,
  // v2 — threads + messages projections (rebuildable from the event log).
  `
  CREATE TABLE threads (
    thread_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    worktree_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    current_turn_id TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    at TEXT NOT NULL,
    seq INTEGER NOT NULL
  );

  CREATE INDEX idx_messages_thread_seq ON messages (thread_id, seq);
  `,
  // v3 — session tree: parent thread lineage on threads.
  `
  ALTER TABLE threads ADD COLUMN parent_thread_id TEXT;
  `,
];

interface EventRow {
  seq: number;
  event_id: string;
  aggregate_kind: string;
  stream_id: string;
  stream_version: number;
  type: string;
  occurred_at: string;
  command_id: string | null;
  causation_event_id: string | null;
  payload_json: string;
}

interface ReceiptRow {
  command_id: string;
  aggregate_kind: string;
  aggregate_id: string;
  accepted_at: string;
  result_sequence: number;
  status: string;
  error: string | null;
}

interface ProjectRow {
  project_id: string;
  title: string;
  workspace_root: string;
}

interface WorktreeRow {
  id: string;
  project_id: string;
  name: string;
  branch: string;
  path: string;
  base_ref: string;
  created_at: string;
}

interface ThreadRow {
  thread_id: string;
  project_id: string;
  worktree_id: string;
  title: string;
  status: SessionStatus;
  current_turn_id: string | null;
  parent_thread_id: string | null;
  created_at: string;
}

interface MessageRow {
  id: string;
  thread_id: string;
  role: MessageRole;
  text: string;
  at: string;
  seq: number;
}

function rowToEvent(row: EventRow): Event {
  return EventSchema.parse({
    sequence: row.seq,
    eventId: row.event_id,
    aggregateKind: row.aggregate_kind,
    aggregateId: row.stream_id,
    streamVersion: row.stream_version,
    occurredAt: row.occurred_at,
    commandId: row.command_id ?? "",
    type: row.type,
    payload: JSON.parse(row.payload_json),
  });
}

function rowToReceipt(row: ReceiptRow): CommandReceipt {
  return CommandReceiptSchema.parse({
    commandId: row.command_id,
    aggregateKind: row.aggregate_kind,
    aggregateId: row.aggregate_id,
    acceptedAt: row.accepted_at,
    resultSequence: row.result_sequence,
    status: row.status,
    error: row.error,
  });
}

/**
 * SQLite-backed event store + projections + receipts. All writes are
 * synchronous; callers wrap multi-statement commits in `transaction`.
 */
export class EventStore {
  private db: DB;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )`,
    );
    const applied = new Set(
      (this.db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map(
        (r) => r.version,
      ),
    );
    const applyAll = this.db.transaction(() => {
      for (let i = 0; i < MIGRATIONS.length; i++) {
        const version = i + 1;
        if (applied.has(version)) continue;
        this.db.exec(MIGRATIONS[i]!);
        this.db
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(version, new Date().toISOString());
      }
    });
    applyAll();
  }

  /** Run `fn` in a single transaction and return its result. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // --- events --------------------------------------------------------------

  /**
   * Persist one event. Assigns `stream_version` inline (COALESCE(MAX+1, 0) per
   * aggregate) and `sequence` via AUTOINCREMENT. Returns the event with real
   * sequence + streamVersion.
   */
  append(event: Event): Event {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(stream_version), -1) AS max_version FROM events WHERE aggregate_kind = ? AND stream_id = ?",
      )
      .get(event.aggregateKind, event.aggregateId) as { max_version: number };
    const streamVersion = row.max_version + 1;
    const info = this.db
      .prepare(
        `INSERT INTO events
           (event_id, aggregate_kind, stream_id, stream_version, type, occurred_at, command_id, causation_event_id, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.eventId,
        event.aggregateKind,
        event.aggregateId,
        streamVersion,
        event.type,
        event.occurredAt,
        event.commandId,
        null,
        JSON.stringify(event.payload),
      );
    return { ...event, sequence: Number(info.lastInsertRowid), streamVersion };
  }

  readAll(): Event[] {
    const rows = this.db.prepare("SELECT * FROM events ORDER BY seq ASC").all() as EventRow[];
    return rows.map(rowToEvent);
  }

  readStream(aggregateKind: string, id: string): Event[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM events WHERE aggregate_kind = ? AND stream_id = ? ORDER BY stream_version ASC",
      )
      .all(aggregateKind, id) as EventRow[];
    return rows.map(rowToEvent);
  }

  readAfter(sequence: number): Event[] {
    const rows = this.db.prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq ASC").all(sequence) as EventRow[];
    return rows.map(rowToEvent);
  }

  // --- receipts ------------------------------------------------------------

  upsertReceipt(receipt: CommandReceipt): void {
    this.db
      .prepare(
        `INSERT INTO command_receipts
           (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error)
         VALUES (@commandId, @aggregateKind, @aggregateId, @acceptedAt, @resultSequence, @status, @error)
         ON CONFLICT(command_id) DO UPDATE SET
           aggregate_kind = excluded.aggregate_kind,
           aggregate_id = excluded.aggregate_id,
           accepted_at = excluded.accepted_at,
           result_sequence = excluded.result_sequence,
           status = excluded.status,
           error = excluded.error`,
      )
      .run({
        commandId: receipt.commandId,
        aggregateKind: receipt.aggregateKind,
        aggregateId: receipt.aggregateId,
        acceptedAt: receipt.acceptedAt,
        resultSequence: receipt.resultSequence,
        status: receipt.status,
        error: receipt.error,
      });
  }

  getReceipt(commandId: string): CommandReceipt | undefined {
    const row = this.db
      .prepare("SELECT * FROM command_receipts WHERE command_id = ?")
      .get(commandId) as ReceiptRow | undefined;
    return row ? rowToReceipt(row) : undefined;
  }

  // --- projections ---------------------------------------------------------

  applyProjection(event: Event): void {
    switch (event.type) {
      case "project.created":
        this.db
          .prepare(
            "INSERT OR REPLACE INTO projects (project_id, title, workspace_root, created_at) VALUES (?, ?, ?, ?)",
          )
          .run(event.payload.projectId, event.payload.title, event.payload.workspaceRoot, event.occurredAt);
        break;
      case "worktree.created":
        this.db
          .prepare(
            "INSERT OR REPLACE INTO worktrees (id, project_id, name, branch, path, base_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            event.payload.worktreeId,
            event.payload.projectId,
            event.payload.name,
            event.payload.branch,
            event.payload.path,
            event.payload.baseRef,
            event.occurredAt,
          );
        break;
      case "worktree.removed":
        this.db.prepare("DELETE FROM worktrees WHERE id = ?").run(event.payload.worktreeId);
        break;
      case "thread.created":
        this.db
          .prepare(
            `INSERT OR REPLACE INTO threads (thread_id, project_id, worktree_id, title, status, current_turn_id, parent_thread_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            event.payload.threadId,
            event.payload.projectId,
            event.payload.worktreeId,
            event.payload.title,
            "idle",
            null,
            event.payload.parentThreadId ?? null,
            event.occurredAt,
          );
        if (event.payload.messages && event.payload.messages.length > 0) {
          const insert = this.db.prepare(
            `INSERT OR IGNORE INTO messages (id, thread_id, role, text, at, seq) VALUES (?, ?, ?, ?, ?, ?)`,
          );
          event.payload.messages.forEach((m, i) => {
            insert.run(m.id, event.payload.threadId, m.role, m.text, m.at, event.sequence + i);
          });
        }
        break;
      case "thread.compacted": {
        this.db.prepare("DELETE FROM messages WHERE thread_id = ?").run(event.payload.threadId);
        const insert = this.db.prepare(
          `INSERT OR IGNORE INTO messages (id, thread_id, role, text, at, seq) VALUES (?, ?, ?, ?, ?, ?)`,
        );
        event.payload.messages.forEach((m, i) => {
          insert.run(m.id, event.payload.threadId, m.role, m.text, m.at, event.sequence + i);
        });
        break;
      }
      case "thread.turn.started":
        this.db
          .prepare("UPDATE threads SET current_turn_id = ? WHERE thread_id = ?")
          .run(event.payload.turnId, event.payload.threadId);
        break;
      case "thread.message.appended":
        this.db
          .prepare(
            `INSERT OR IGNORE INTO messages (id, thread_id, role, text, at, seq)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            event.payload.message.id,
            event.payload.threadId,
            event.payload.message.role,
            event.payload.message.text,
            event.payload.message.at,
            event.sequence,
          );
        break;
      case "thread.turn.completed":
      case "thread.turn.failed":
        this.db
          .prepare("UPDATE threads SET current_turn_id = NULL WHERE thread_id = ?")
          .run(event.payload.threadId);
        break;
      case "thread.session.set":
        this.db
          .prepare("UPDATE threads SET status = ? WHERE thread_id = ?")
          .run(event.payload.status, event.payload.threadId);
        break;
    }
  }

  updateProjectionState(sequence: number): void {
    this.db
      .prepare(
        `INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
         VALUES ('default', ?, ?)
         ON CONFLICT(projector) DO UPDATE SET
           last_applied_sequence = excluded.last_applied_sequence,
           updated_at = excluded.updated_at`,
      )
      .run(sequence, new Date().toISOString());
  }

  loadReadModel(): ReadModel {
    const projects = (
      this.db.prepare("SELECT project_id, title, workspace_root FROM projects").all() as ProjectRow[]
    ).map((r) => ({ projectId: r.project_id, title: r.title, workspaceRoot: r.workspace_root }));

    const worktrees = (
      this.db.prepare("SELECT * FROM worktrees").all() as WorktreeRow[]
    ).map((r) => ({
      worktreeId: r.id,
      projectId: r.project_id,
      name: r.name,
      baseRef: r.base_ref,
      branch: r.branch,
      path: r.path,
      createdAt: r.created_at,
    }));

    const threadRows = this.db.prepare("SELECT * FROM threads").all() as ThreadRow[];
    const messageRows = this.db
      .prepare("SELECT * FROM messages ORDER BY seq ASC")
      .all() as MessageRow[];

    const messagesByThread = new Map<string, MessageRow[]>();
    for (const m of messageRows) {
      const list = messagesByThread.get(m.thread_id) ?? [];
      list.push(m);
      messagesByThread.set(m.thread_id, list);
    }

    const threads = threadRows.map((r) => ({
      threadId: r.thread_id,
      projectId: r.project_id,
      worktreeId: r.worktree_id,
      title: r.title,
      parentThreadId: r.parent_thread_id,
      messages: (messagesByThread.get(r.thread_id) ?? []).map((m) => ({
        id: m.id,
        role: m.role,
        text: m.text,
        at: m.at,
      })),
      session: { status: r.status },
      currentTurnId: r.current_turn_id,
      createdAt: r.created_at,
    }));

    const state = this.db
      .prepare("SELECT last_applied_sequence FROM projection_state WHERE projector = 'default'")
      .get() as { last_applied_sequence: number } | undefined;

    return {
      projects,
      worktrees,
      threads,
      snapshotSequence: state?.last_applied_sequence ?? 0,
    };
  }
}
