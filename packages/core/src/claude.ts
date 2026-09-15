import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ApprovalDecision, ProviderRuntimeEvent } from "@roost/contracts";
import {
  AsyncQueue,
  type DistributiveOmit,
  type ProviderAdapter,
  type ProviderCapabilities,
  type SendTurnInput,
  type StartSessionInput,
} from "./provider.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ClaudeCodeAdapterOptions {
  /** Model passed as `--model`; omitted → Claude's configured default. */
  model?: string;
  /** `"manual"` prompts for every tool; `"acceptEdits"` auto-accepts file edits. */
  permissionMode?: "acceptEdits" | "manual";
}

interface Session {
  cwd: string;
  sessionId: string;
  /** The long-lived `claude` process; null before first spawn and after it dies. */
  child: ChildProcess | null;
  /** The turn currently in flight, or null when idle. */
  activeTurnId: string | null;
  /** True once the process has spawned at least once (respawns use `--resume`). */
  spawnedOnce: boolean;
  /** Set by interruptTurn; the next `result` is reported as "interrupted". */
  interrupted: boolean;
}

function summarize(input: unknown): string {
  if (input == null) return "";
  const s = JSON.stringify(input);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

/**
 * Pure parser for a permission control request. A `can_use_tool` control_request
 * becomes `{ requestId, summary }`; anything else is `null`. Exposed for tests.
 */
export function parseControlRequest(msg: unknown): { requestId: string; summary: string } | null {
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== "control_request") return null;
  const requestId = typeof m.request_id === "string" ? m.request_id : "";
  if (!requestId) return null;
  const req = m.request as Record<string, unknown> | undefined;
  if (!req || req.subtype !== "can_use_tool") return null;
  const tool = typeof req.tool_name === "string" ? req.tool_name : "tool";
  return { requestId, summary: `${tool} ${summarize(req.input)}` };
}

/**
 * Tier-2 CLI adapter: drives one long-lived `claude` process per thread in
 * `--input-format stream-json --output-format stream-json --permission-mode`
 * mode, so multi-turn conversation runs on a single session AND permission
 * prompts (`control_request` / `can_use_tool`) are surfaced as
 * `approval.requested`, resolved via `respondToRequest` writing a
 * `control_response` back on stdin.
 *
 * Lazy + resilient: `claude` is spawned on the first `sendTurn`; if it is
 * missing from PATH or not authenticated the failure surfaces as a
 * `turn.failed` event (never a crash). If the process dies mid-conversation the
 * next turn respawns with `--resume <sessionId>`.
 */
export class ClaudeCodeAdapter implements ProviderAdapter {
  readonly provider = "claude-cli";
  readonly tier = "cli" as const;
  readonly capabilities: ProviderCapabilities = {
    sessionModelSwitch: "none",
    supportsRollback: false,
    supportsCompaction: false,
    supportsApproval: true,
  };

  private readonly queue = new AsyncQueue<ProviderRuntimeEvent>();
  private readonly sessions = new Map<string, Session>();
  private readonly approvals = new Map<string, string>(); // requestId -> threadId
  private readonly toolNames = new Map<string, string>();
  private readonly model?: string;
  private readonly permissionMode: "acceptEdits" | "manual";

  constructor(opts: ClaudeCodeAdapterOptions = {}) {
    this.model = opts.model;
    this.permissionMode = opts.permissionMode ?? "acceptEdits";
  }

  private emit(threadId: string, event: DistributiveOmit<ProviderRuntimeEvent, "threadId">): void {
    this.queue.push({ ...event, threadId } as ProviderRuntimeEvent);
  }

  async startSession(input: StartSessionInput): Promise<void> {
    const sessionId = UUID_RE.test(input.threadId) ? input.threadId : randomUUID();
    this.sessions.set(input.threadId, {
      cwd: input.cwd,
      sessionId,
      child: null,
      activeTurnId: null,
      spawnedOnce: false,
      interrupted: false,
    });
  }

  async sendTurn(input: SendTurnInput): Promise<void> {
    const session = this.sessions.get(input.threadId);
    if (!session) {
      this.emit(input.threadId, { type: "turn.failed", error: "session not started" });
      return;
    }
    const child = this.ensureChild(input.threadId, session);
    if (!child) return; // spawn failure already emitted a turn.failed
    session.activeTurnId = input.turnId;
    session.interrupted = false;
    this.write(input.threadId, child, {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: input.prompt }] },
    });
  }

  async interruptTurn(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    const child = session?.child;
    if (!child || !child.stdin || child.stdin.destroyed || session.activeTurnId === null) return;
    session.interrupted = true;
    this.write(threadId, child, {
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "interrupt" },
    });
  }

  async respondToRequest(
    threadId: string,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    if (this.approvals.get(requestId) !== threadId) return; // unknown or already handled
    this.approvals.delete(requestId);
    const child = this.sessions.get(threadId)?.child;
    if (!child || !child.stdin || child.stdin.destroyed) return;
    this.write(threadId, child, {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response:
          decision === "allow"
            ? { behavior: "allow" }
            : { behavior: "deny", message: "denied by user" },
      },
    });
  }

  async stopSession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    if (session.child && !session.child.killed) {
      if (session.child.stdin && !session.child.stdin.destroyed) session.child.stdin.end();
      session.child.kill();
    }
    this.sessions.delete(threadId);
    for (const [requestId, owner] of [...this.approvals]) {
      if (owner === threadId) this.approvals.delete(requestId);
    }
    this.emit(threadId, { type: "session.ended" });
  }

  streamEvents(): AsyncIterable<ProviderRuntimeEvent> {
    return this.queue.drain();
  }

  private ensureChild(threadId: string, session: Session): ChildProcess | null {
    if (session.child && session.child.exitCode === null && !session.child.killed) {
      return session.child;
    }
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--permission-mode",
      this.permissionMode,
      session.spawnedOnce ? "--resume" : "--session-id",
      session.sessionId,
    ];
    if (this.model) args.push("--model", this.model);

    let child: ChildProcess;
    try {
      child = spawn("claude", args, {
        cwd: session.cwd,
        shell: false,
        windowsHide: true,
        env: process.env,
      });
    } catch (err) {
      this.emit(threadId, {
        type: "turn.failed",
        error: `claude spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return null;
    }
    session.child = child;
    session.spawnedOnce = true;
    this.wireChild(threadId, session, child);
    return child;
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
          if (line) this.handleLine(threadId, line, session);
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

    const stdin = child.stdin;
    if (stdin) {
      // EPIPE when the process exits while we still write; the close handler fails the turn.
      stdin.on("error", () => {});
    }

    child.on("error", (err) => {
      this.failActive(threadId, session, `claude not found on PATH (${err.message})`);
    });

    child.on("close", (code) => {
      if (session.child === child) session.child = null;
      const detail = stderrTail.trim();
      this.failActive(
        threadId,
        session,
        `claude exited with code ${code ?? "unknown"}${detail ? `: ${detail}` : ""}`,
      );
    });
  }

  /** Fail the in-flight turn (if any) and clear it. No-op when idle. */
  private failActive(threadId: string, session: Session, error: string): void {
    if (session.activeTurnId === null) return;
    session.activeTurnId = null;
    session.interrupted = false;
    this.emit(threadId, { type: "turn.failed", error });
  }

  private write(threadId: string, child: ChildProcess, msg: unknown): void {
    const stdin = child.stdin;
    if (!stdin || stdin.destroyed) return;
    stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private handleLine(threadId: string, line: string, session: Session): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    // Permission prompt: surface as approval.requested, resolved via control_response.
    const approval = parseControlRequest(msg);
    if (approval) {
      this.approvals.set(approval.requestId, threadId);
      this.emit(threadId, {
        type: "approval.requested",
        requestId: approval.requestId,
        summary: approval.summary,
      });
      return;
    }

    const type = typeof msg.type === "string" ? msg.type : "";

    switch (type) {
      case "system":
        if (msg.subtype === "init") this.emit(threadId, { type: "session.started" });
        return;

      case "stream_event": {
        // --include-partial-messages: live text deltas.
        const event = (msg.event ?? {}) as Record<string, unknown>;
        if (event.type === "content_block_delta") {
          const delta = (event.delta ?? {}) as Record<string, unknown>;
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            this.emit(threadId, { type: "message.delta", text: delta.text });
          }
        }
        return;
      }

      case "assistant": {
        const content = Array.isArray((msg.message as { content?: unknown[] } | undefined)?.content)
          ? ((msg.message as { content: unknown[] }).content)
          : [];
        let text = "";
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string") {
            text += b.text;
          } else if (b.type === "tool_use") {
            const name = typeof b.name === "string" ? b.name : "tool";
            if (typeof b.id === "string") this.toolNames.set(b.id, name);
            this.emit(threadId, {
              type: "tool.started",
              name,
              inputSummary: summarize(b.input),
            });
          }
        }
        if (text) this.emit(threadId, { type: "message.completed", text });
        return;
      }

      case "user": {
        const content = Array.isArray((msg.message as { content?: unknown[] } | undefined)?.content)
          ? ((msg.message as { content: unknown[] }).content)
          : [];
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === "tool_result") {
            const id = typeof b.tool_use_id === "string" ? b.tool_use_id : "";
            const name = this.toolNames.get(id) ?? "tool";
            this.emit(threadId, { type: "tool.completed", name, ok: !b.is_error });
          }
        }
        return;
      }

      case "result": {
        if (session.activeTurnId === null) return;
        session.activeTurnId = null;
        const interrupted = session.interrupted;
        session.interrupted = false;
        if (interrupted) {
          this.emit(threadId, { type: "turn.failed", error: "interrupted" });
        } else if (msg.is_error) {
          const err =
            typeof msg.result === "string"
              ? msg.result
              : `claude error (${String(msg.subtype ?? "unknown")})`;
          this.emit(threadId, { type: "turn.failed", error: err });
        } else {
          this.emit(threadId, { type: "turn.completed" });
        }
        return;
      }
    }
  }
}
