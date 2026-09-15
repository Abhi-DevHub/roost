import { EventEmitter } from "node:events";
import type { Command, Event, ReadModel } from "@roost/contracts";
import { DispatchResponseSchema, StateResponseSchema, SubscribeEventSchema } from "@roost/contracts";
import { emptyReadModel, projectEvent } from "./decider.js";
import type { RoostEngine } from "./engine.js";

// ---------------------------------------------------------------------------
// DaemonClient — a thin HTTP/WS client that mirrors the `OrchestrationEngine`
// surface over the wire. The read model is reconstructed from the server's
// `/state` snapshot plus the ordered WebSocket event stream (replay + live),
// so `getReadModel()` stays synchronous and the TUI/commands work unchanged.
// ---------------------------------------------------------------------------

export interface DaemonClientOptions {
  serverUrl: string;
  directory: string;
}

export class DaemonClient extends EventEmitter implements RoostEngine {
  private readModel: ReadModel = emptyReadModel();
  private ws: WebSocket | null = null;
  private readonly recent: Event[] = [];

  constructor(private readonly opts: DaemonClientOptions) {
    super();
  }

  getReadModel(): ReadModel {
    return this.readModel;
  }

  private header(): Record<string, string> {
    return { "x-roost-directory": this.opts.directory };
  }

  /** `GET /state` — one-shot read-model snapshot (no WebSocket). */
  async fetchState(): Promise<ReadModel> {
    const res = await fetch(`${this.opts.serverUrl}/state`, { headers: this.header() });
    if (!res.ok) {
      throw new Error(`GET /state failed: ${res.status} ${await res.text()}`);
    }
    const parsed = StateResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      throw new Error(`invalid /state response: ${parsed.error.message}`);
    }
    return parsed.data.readModel;
  }

  /** Snapshot the read model, then subscribe to events from the snapshot sequence. */
  async connect(): Promise<void> {
    const state = await this.fetchState();
    this.readModel = state;
    await this.openWs(state.snapshotSequence);
  }

  async dispatch(command: Command): Promise<{ sequence: number }> {
    const res = await fetch(`${this.opts.serverUrl}/rpc/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.header() },
      body: JSON.stringify({ command }),
    });
    const body = await res.json().catch(() => null);
    const parsed = DispatchResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(
        `dispatch failed: ${res.status} ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      );
    }
    if (!parsed.data.ok) throw new Error(parsed.data.error);
    return { sequence: parsed.data.receipt.resultSequence };
  }

  async waitForSequence(sequence: number, timeoutMs = 10_000): Promise<void> {
    if (this.readModel.snapshotSequence >= sequence) return;
    await this.waitForEvent((e) => e.sequence >= sequence, timeoutMs).then(() => undefined);
  }

  waitForEvent(predicate: (event: Event) => boolean, timeoutMs = 10_000): Promise<Event> {
    const seen = this.recent.find(predicate);
    if (seen) return Promise.resolve(seen);
    return new Promise<Event>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("event", handler);
        reject(new Error("timed out waiting for event"));
      }, timeoutMs);
      const handler = (event: Event) => {
        if (!predicate(event)) return;
        clearTimeout(timer);
        this.off("event", handler);
        resolve(event);
      };
      this.on("event", handler);
    });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  private openWs(fromSequence: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const base = new URL(this.opts.serverUrl);
      const protocol = base.protocol === "https:" ? "wss" : "ws";
      const url = `${protocol}://${base.host}/events?fromSequence=${fromSequence}&directory=${encodeURIComponent(this.opts.directory)}`;
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`WebSocket connect failed: ${url}`));
      ws.onmessage = (msg) => {
        const parsed = SubscribeEventSchema.safeParse(JSON.parse(String(msg.data)));
        if (parsed.success) this.applyEvent(parsed.data.event);
      };
      ws.onclose = () => {
        this.ws = null;
      };
    });
  }

  private applyEvent(event: Event): void {
    if (event.sequence <= this.readModel.snapshotSequence) return;
    this.readModel = projectEvent(this.readModel, event);
    this.recent.push(event);
    if (this.recent.length > 256) this.recent.shift();
    this.emit("event", event);
  }
}
