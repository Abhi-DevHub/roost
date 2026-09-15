import { randomUUID } from "node:crypto";
import type { Event } from "@roost/contracts";
import type { RoostEngine } from "./engine.js";

// ---------------------------------------------------------------------------
// Non-interactive run modes — drive one turn to completion and emit committed
// events. The CLI's `--format json` and `--mode rpc` both build on this.
// ---------------------------------------------------------------------------

export interface RunTurnAndWaitInput {
  engine: RoostEngine;
  threadId: string;
  prompt: string;
  /** Invoked for every committed event (streamed as JSON lines by the CLI). */
  onEvent?: (event: Event) => void;
  timeoutMs?: number;
}

export interface RunTurnAndWaitResult {
  ok: boolean;
  error?: string;
}

/**
 * Start a turn and resolve when it completes or fails. The caller is expected
 * to have already started the `TurnReactor`. Every committed event is passed
 * to `onEvent`; the terminal event determines `ok`.
 */
export async function runTurnAndWait(input: RunTurnAndWaitInput): Promise<RunTurnAndWaitResult> {
  const { engine, threadId, prompt, onEvent, timeoutMs = 120_000 } = input;

  return new Promise<RunTurnAndWaitResult>((resolve) => {
    let settled = false;
    const settle = (ok: boolean, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      engine.off("event", handler);
      resolve({ ok, error });
    };

    const timer = setTimeout(() => settle(false, "timed out waiting for turn end"), timeoutMs);

    const handler = (event: Event): void => {
      onEvent?.(event);
      if (event.aggregateId !== threadId) return;
      if (event.type === "thread.turn.completed") settle(true);
      else if (event.type === "thread.turn.failed") settle(false, event.payload.error);
    };

    engine.on("event", handler);
    engine
      .dispatch({
        type: "thread.turn.start",
        threadId,
        turnId: randomUUID(),
        prompt,
        commandId: randomUUID(),
        createdAt: new Date().toISOString(),
      })
      .catch((err: unknown) => settle(false, err instanceof Error ? err.message : String(err)));
  });
}

/** Serialize one committed event as a JSONL `{ event }` line. */
export function formatEventLine(event: Event): string {
  return JSON.stringify({ event });
}
