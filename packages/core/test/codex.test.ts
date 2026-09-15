import { describe, it, expect } from "vitest";
import { normalizeCodexEvent } from "../src/codex.js";

describe("normalizeCodexEvent", () => {
  it("maps thread.started → session.started", () => {
    expect(normalizeCodexEvent({ type: "thread.started", thread_id: "t1" })).toEqual({
      type: "session.started",
    });
  });

  it("maps turn.completed → turn.completed", () => {
    expect(normalizeCodexEvent({ type: "turn.completed", usage: { input_tokens: 1 } })).toEqual({
      type: "turn.completed",
    });
  });

  it("maps turn.failed → turn.failed with the error message", () => {
    expect(normalizeCodexEvent({ type: "turn.failed", error: { message: "boom" } })).toEqual({
      type: "turn.failed",
      error: "boom",
    });
  });

  it("maps error → turn.failed", () => {
    expect(normalizeCodexEvent({ type: "error", message: "fatal" })).toEqual({
      type: "turn.failed",
      error: "fatal",
    });
  });

  it("maps an agent-message item.completed → message.completed", () => {
    const event = {
      type: "item.completed",
      item: { id: "i1", details: { type: "agent_message", text: "hello from codex" } },
    };
    expect(normalizeCodexEvent(event)).toEqual({ type: "message.completed", text: "hello from codex" });
  });

  it("maps a function_call_output item → tool.completed", () => {
    const event = {
      type: "item.completed",
      item: { id: "i2", details: { type: "function_call_output", name: "shell", is_error: false } },
    };
    expect(normalizeCodexEvent(event)).toEqual({ type: "tool.completed", name: "shell", ok: true });
  });

  it("returns null for unrecognized or malformed events", () => {
    expect(normalizeCodexEvent({ type: "turn.started" })).toBeNull();
    expect(normalizeCodexEvent("garbage")).toBeNull();
    expect(normalizeCodexEvent(null)).toBeNull();
    expect(normalizeCodexEvent(42)).toBeNull();
    expect(normalizeCodexEvent({})).toBeNull();
  });
});
