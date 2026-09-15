import { spawn, type ChildProcess } from "node:child_process";
import type { ProviderRuntimeEvent } from "@roost/contracts";
import {
  AsyncQueue,
  type DistributiveOmit,
  type ProviderAdapter,
  type ProviderCapabilities,
  type SendTurnInput,
  type StartSessionInput,
} from "./provider.js";

// ---------------------------------------------------------------------------
// Codex CLI adapter — Tier-2 provider for the `codex` CLI. Each turn spawns a
// one-shot `codex exec --json <prompt>` process and normalizes its JSONL
// output (thread.started / turn.completed / turn.failed / item.* / error) to
// canonical `ProviderRuntimeEvent`s. Missing `codex` degrades to an explicit
// `turn.failed`, never a crash.
// ---------------------------------------------------------------------------

export interface CodexCliAdapterOptions {
  /** Model passed as `--model`; omitted → codex's configured default. */
  model?: string;
}

interface Session {
  cwd: string;
  child: ChildProcess | null;
  activeTurnId: string | null;
  interrupted: boolean;
  /** True once the current process emitted a terminal turn event. */
  terminal: boolean;
}

function summarize(input: unknown): string {
  if (input == null) return "";
  const s = JSON.stringify(input);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

function textOf(item: unknown): string | null {
  if (typeof item !== "object" || item === null) return null;
  const it = item as Record<string, unknown>;
  const details = it.details as Record<string, unknown> | undefined;
  const direct = typeof it.text === "string" ? it.text : null;
  const nested = details && typeof details.text === "string" ? details.text : null;
  return nested ?? direct;
}

function toolNameOf(item: unknown): string | null {
  if (typeof item !== "object" || item === null) return null;
  const it = item as Record<string, unknown>;
  const details = it.details as Record<string, unknown> | undefined;
  for (const key of ["tool_name", "name"]) {
    const direct = typeof it[key] === "string" ? (it[key] as string) : null;
    const nested = details && typeof details[key] === "string" ? (details[key] as string) : null;
    if (nested ?? direct) return nested ?? direct;
  }
  return null;
}

/**
 * Normalize one Codex JSONL event to a canonical runtime event (minus the
 * thread id). Returns null for events with no canonical equivalent.
 */
export function normalizeCodexEvent(msg: unknown): DistributiveOmit<ProviderRuntimeEvent, "threadId"> | null {
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as Record<string, unknown>;
  const type = typeof m.type === "string" ? m.type : "";

  switch (type) {
    case "thread.started":
      return { type: "session.started" };
    case "turn.completed":
      return { type: "turn.completed" };
    case "turn.failed": {
      const err = m.error as Record<string, unknown> | undefined;
      const message = err && typeof err.message === "string" ? err.message : "codex turn failed";
      return { type: "turn.failed", error: message };
    }
    case "error":
      return { type: "turn.failed", error: typeof m.message === "string" ? m.message : "codex error" };
    case "item.completed":
      return normalizeCodexItem(m.item);
    default:
      return null;
  }
}

function normalizeCodexItem(item: unknown): DistributiveOmit<ProviderRuntimeEvent, "threadId"> | null {
  if (typeof item !== "object" || item === null) return null;
  const it = item as Record<string, unknown>;
  const details = it.details as Record<string, unknown> | undefined;
  const kind = details && typeof details.type === "string" ? (details.type as string) : "";
  const text = textOf(item);

  if (text) return { type: "message.completed", text };

  const name = toolNameOf(item);
  if (kind === "function_call_output") {
    const isError = details ? (details.is_error as boolean | undefined) ?? false : false;
    return { type: "tool.completed", name: name ?? "tool", ok: !isError };
  }
  if (name) {
    return { type: "tool.started", name, inputSummary: summarize(details?.arguments ?? details?.input) };
  }
  return null;
}

export class CodexCliAdapter implements ProviderAdapter {
  readonly provider = "codex-cli";
  readonly tier = "cli" as const;
  readonly capabilities: ProviderCapabilities = {
    sessionModelSwitch: "none",
    supportsRollback: false,
    supportsCompaction: false,
    supportsApproval: false,
  };

  private readonly queue = new AsyncQueue<ProviderRuntimeEvent>();
  private readonly sessions = new Map<string, Session>();
  private readonly model?: string;

  constructor(opts: CodexCliAdapterOptions = {}) {
    this.model = opts.model;
  }

  private emit(threadId: string, event: DistributiveOmit<ProviderRuntimeEvent, "threadId">): void {
    this.queue.push({ ...event, threadId } as ProviderRuntimeEvent);
  }

  async startSession(input: StartSessionInput): Promise<void> {
    this.sessions.set(input.threadId, {
      cwd: input.cwd,
      child: null,
      activeTurnId: null,
      interrupted: false,
      terminal: false,
    });
  }

  async sendTurn(input: SendTurnInput): Promise<void> {
    const session = this.sessions.get(input.threadId);
    if (!session) {
      this.emit(input.threadId, { type: "turn.failed", error: "session not started" });
      return;
    }
    const args = ["exec", "--json"];
    if (this.model) args.push("--model", this.model);
    args.push(input.prompt);

    let child: ChildProcess;
    try {
      child = spawn("codex", args, {
        cwd: session.cwd,
        shell: false,
        windowsHide: true,
        env: process.env,
      });
    } catch (err) {
      this.emit(input.threadId, {
        type: "turn.failed",
        error: `codex spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    session.child = child;
    session.activeTurnId = input.turnId;
    session.interrupted = false;
    session.terminal = false;
    this.wireChild(input.threadId, session, child);
  }

  async interruptTurn(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    const child = session?.child;
    if (!child || session?.activeTurnId === null) return;
    session.interrupted = true;
    if (!child.killed) child.kill();
  }

  async respondToRequest(): Promise<void> {
    // Codex CLI adapter does not surface approval prompts (supportsApproval: false).
  }

  async stopSession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    if (session.child && !session.child.killed) session.child.kill();
    this.sessions.delete(threadId);
    this.emit(threadId, { type: "session.ended" });
  }

  streamEvents(): AsyncIterable<ProviderRuntimeEvent> {
    return this.queue.drain();
  }

  private wireChild(threadId: string, session: Session, child: ChildProcess): void {
    const stdout = child.stdout;
    if (stdout) {
      let buffer = "";
      stdout.setEncoding("utf8");
      stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line) this.handleLine(threadId, session, line);
        }
      });
    }

    let stderrTail = "";
    const stderr = child.stderr;
    if (stderr) {
      stderr.setEncoding("utf8");
      stderr.on("data", (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-1000);
      });
    }

    child.on("error", (err) => {
      this.failActive(threadId, session, `codex not found on PATH (${err.message})`);
    });

    child.on("close", (code) => {
      if (session.child === child) session.child = null;
      if (session.activeTurnId === null) return;
      if (!session.terminal) {
        const detail = stderrTail.trim();
        const reason = session.interrupted
          ? "interrupted"
          : `codex exited with code ${code ?? "unknown"}${detail ? `: ${detail}` : ""}`;
        this.failActive(threadId, session, reason);
      }
    });
  }

  private failActive(threadId: string, session: Session, error: string): void {
    if (session.activeTurnId === null) return;
    session.activeTurnId = null;
    session.terminal = true;
    this.emit(threadId, { type: "turn.failed", error });
  }

  private handleLine(threadId: string, session: Session, line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const event = normalizeCodexEvent(msg);
    if (!event) return;
    if (event.type === "turn.completed" || event.type === "turn.failed") {
      session.terminal = true;
      if (session.activeTurnId !== null) session.activeTurnId = null;
    }
    this.emit(threadId, event);
  }
}
