import { describe, it, expect } from "vitest";
import { parseControlRequest } from "../src/claude.js";

describe("parseControlRequest", () => {
  it("extracts a can_use_tool control_request", () => {
    const msg = {
      type: "control_request",
      request_id: "req-1",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "rm -rf /" } },
    };
    const result = parseControlRequest(msg);
    expect(result?.requestId).toBe("req-1");
    expect(result?.summary).toContain("Bash");
    expect(result?.summary).toContain("rm -rf");
  });

  it("returns null for non-permission messages", () => {
    expect(parseControlRequest({ type: "system", subtype: "init" })).toBeNull();
    expect(
      parseControlRequest({ type: "control_request", request_id: "r", request: { subtype: "initialize" } }),
    ).toBeNull();
    expect(parseControlRequest({ type: "assistant", message: {} })).toBeNull();
  });

  it("returns null for malformed or non-object input", () => {
    expect(parseControlRequest("garbage")).toBeNull();
    expect(parseControlRequest(null)).toBeNull();
    expect(parseControlRequest(42)).toBeNull();
    expect(parseControlRequest({ type: "control_request" })).toBeNull();
  });
});
