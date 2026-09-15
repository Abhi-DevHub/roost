import type { ApprovalDecision, ProviderRuntimeEvent } from "@roost/contracts";

// ---------------------------------------------------------------------------
// Provider adapter — the boundary between the event-sourced core and an
// external agent runtime (a CLI like Claude Code, or a native loop in Phase 2).
// ---------------------------------------------------------------------------

export interface ProviderCapabilities {
  sessionModelSwitch: "in-session" | "none";
  supportsRollback: boolean;
  supportsCompaction: boolean;
  supportsApproval: boolean;
}

export interface StartSessionInput {
  threadId: string;
  /** Working directory the agent runs in (the thread's worktree). */
  cwd: string;
}

export interface SendTurnInput {
  threadId: string;
  prompt: string;
  turnId: string;
}

export interface ProviderAdapter {
  /** Stable identifier, e.g. `"claude-cli"` or `"fake"`. */
  readonly provider: string;
  readonly tier: "cli" | "native";
  readonly capabilities: ProviderCapabilities;
  startSession(input: StartSessionInput): Promise<void>;
  sendTurn(input: SendTurnInput): Promise<void>;
  interruptTurn(threadId: string, turnId?: string): Promise<void>;
  respondToRequest(threadId: string, requestId: string, decision: ApprovalDecision): Promise<void>;
  stopSession(threadId: string): Promise<void>;
  /** A single push-based stream of canonical runtime events for all sessions. */
  streamEvents(): AsyncIterable<ProviderRuntimeEvent>;
}

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

/** Unknown provider id → explicit error, never a silent fallback. */
export class UnknownProviderError extends Error {
  constructor(provider: string) {
    super(`unknown provider: ${provider}`);
    this.name = "UnknownProviderError";
  }
}

export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();
  private defaultName: string | null = null;

  /** Registers an adapter and returns `this` for chaining. */
  register(adapter: ProviderAdapter, opts: { default?: boolean } = {}): this {
    this.adapters.set(adapter.provider, adapter);
    if (opts.default) this.defaultName = adapter.provider;
    return this;
  }

  get(name: string): ProviderAdapter {
    const adapter = this.adapters.get(name);
    if (!adapter) throw new UnknownProviderError(name);
    return adapter;
  }

  /** The adapter marked default, or the only adapter. Throws if none resolved. */
  resolveDefault(): ProviderAdapter {
    if (this.defaultName) return this.get(this.defaultName);
    if (this.adapters.size === 1) return [...this.adapters.values()][0]!;
    throw new UnknownProviderError("<default>");
  }

  has(name: string): boolean {
    return this.adapters.has(name);
  }
}

// ---------------------------------------------------------------------------
// Async push-queue helper (shared by adapters that emit from I/O callbacks)
// ---------------------------------------------------------------------------

/** Minimal unbounded async queue with a `push` and an async `drain`. */
export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: (() => void)[] = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    this.items.push(item);
    const w = this.waiters.shift();
    if (w) w();
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w();
  }

  async *drain(): AsyncIterable<T> {
    let i = 0;
    for (;;) {
      while (i < this.items.length) {
        yield this.items[i]!;
        i++;
      }
      this.items = this.items.slice(i);
      i = 0;
      if (this.closed) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

// ---------------------------------------------------------------------------
// FakeProvider — scripted, deterministic, no subprocess. Used by tests and as
// a drop-in stand-in when no real CLI provider is configured.
// ---------------------------------------------------------------------------

export type Emit = (event: DistributiveOmit<ProviderRuntimeEvent, "threadId">) => void;

/** `Omit` over a union collapses to shared keys; distribute instead. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface FakeScriptContext {
  emit: Emit;
  /** Emits `approval.requested` and resolves when `respondToRequest` is called. */
  awaitApproval: (requestId: string, summary: string) => Promise<ApprovalDecision>;
  /** True once `interruptTurn` has been called for the active turn. */
  isAborted: () => boolean;
  /** Emits `message.delta` * `count`; convenience for streaming tests. */
  stream: (chunks: string[]) => void;
}

export type FakeScript = (
  threadId: string,
  turnId: string,
  prompt: string,
  ctx: FakeScriptContext,
) => Promise<void>;

/** Emits a couple of deltas, a completed message, then `turn.completed`. */
export const defaultFakeScript: FakeScript = async (_threadId, _turnId, _prompt, ctx) => {
  ctx.stream(["Hello", ", ", "world."]);
  ctx.emit({ type: "message.completed", text: "Hello, world." });
  ctx.emit({ type: "turn.completed" });
};

export interface FakeProviderOptions {
  script?: FakeScript;
}

export class FakeProvider implements ProviderAdapter {
  readonly provider = "fake";
  readonly tier = "native" as const;
  readonly capabilities: ProviderCapabilities = {
    sessionModelSwitch: "in-session",
    supportsRollback: false,
    supportsCompaction: false,
    supportsApproval: true,
  };

  private readonly queue = new AsyncQueue<ProviderRuntimeEvent>();
  private readonly sessions = new Map<string, { cwd: string }>();
  private readonly active = new Map<string, { turnId: string; abort: boolean }>();
  private readonly approvals = new Map<string, (d: ApprovalDecision) => void>();
  private readonly script: FakeScript;

  constructor(opts: FakeProviderOptions = {}) {
    this.script = opts.script ?? defaultFakeScript;
  }

  private emit(threadId: string, event: DistributiveOmit<ProviderRuntimeEvent, "threadId">): void {
    this.queue.push({ ...event, threadId } as ProviderRuntimeEvent);
  }

  async startSession(input: StartSessionInput): Promise<void> {
    this.sessions.set(input.threadId, { cwd: input.cwd });
    this.emit(input.threadId, { type: "session.started" });
  }

  async sendTurn(input: SendTurnInput): Promise<void> {
    const state = { turnId: input.turnId, abort: false };
    this.active.set(input.threadId, state);
    const ctx: FakeScriptContext = {
      emit: (e) => this.emit(input.threadId, e),
      awaitApproval: (requestId, summary) => {
        this.emit(input.threadId, { type: "approval.requested", requestId, summary });
        return new Promise<ApprovalDecision>((resolve) => this.approvals.set(requestId, resolve));
      },
      isAborted: () => state.abort,
      stream: (chunks) => {
        for (const c of chunks) this.emit(input.threadId, { type: "message.delta", text: c });
      },
    };
    await this.script(input.threadId, input.turnId, input.prompt, ctx);
    if (!state.abort) this.active.delete(input.threadId);
  }

  async interruptTurn(threadId: string): Promise<void> {
    const state = this.active.get(threadId);
    if (!state) return;
    state.abort = true;
    this.active.delete(threadId);
    this.emit(threadId, { type: "turn.failed", error: "interrupted" });
  }

  async respondToRequest(
    _threadId: string,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    const resolve = this.approvals.get(requestId);
    if (resolve) {
      this.approvals.delete(requestId);
      resolve(decision);
    }
  }

  async stopSession(threadId: string): Promise<void> {
    this.sessions.delete(threadId);
    this.emit(threadId, { type: "session.ended" });
  }

  streamEvents(): AsyncIterable<ProviderRuntimeEvent> {
    return this.queue.drain();
  }
}
