import { describe, it, expect } from "vitest";
import { evaluate, allowAll, readOnly, type Ruleset } from "../src/index.js";

describe("permissions.evaluate", () => {
  it("defaults to ask when no rule matches", () => {
    expect(evaluate("read", {}, [])).toBe("ask");
    expect(evaluate("bash", { command: "ls" }, [{ tool: "read", permission: "allow" }])).toBe("ask");
  });

  it("matches an exact tool name", () => {
    expect(evaluate("read", {}, [{ tool: "read", permission: "allow" }])).toBe("allow");
    expect(evaluate("bash", {}, [{ tool: "bash", permission: "deny" }])).toBe("deny");
  });

  it("supports wildcards", () => {
    expect(evaluate("readFile", {}, [{ tool: "read*", permission: "allow" }])).toBe("allow");
    expect(evaluate("edit", {}, [{ tool: "*", permission: "deny" }])).toBe("deny");
    expect(evaluate("ls", {}, [{ tool: "l?", permission: "allow" }])).toBe("allow");
  });

  it("last matching rule wins (findLast semantics)", () => {
    const ruleset: Ruleset = [
      { tool: "*", permission: "allow" },
      { tool: "bash", permission: "deny" },
    ];
    expect(evaluate("bash", {}, ruleset)).toBe("deny");
    expect(evaluate("read", {}, ruleset)).toBe("allow");
  });

  it("allowAll permits everything", () => {
    expect(evaluate("bash", {}, allowAll)).toBe("allow");
    expect(evaluate("write", {}, allowAll)).toBe("allow");
  });

  it("readOnly denies mutations but allows inspection", () => {
    expect(evaluate("read", {}, readOnly)).toBe("allow");
    expect(evaluate("grep", {}, readOnly)).toBe("allow");
    expect(evaluate("glob", {}, readOnly)).toBe("allow");
    expect(evaluate("ls", {}, readOnly)).toBe("allow");
    expect(evaluate("write", {}, readOnly)).toBe("deny");
    expect(evaluate("edit", {}, readOnly)).toBe("deny");
    expect(evaluate("bash", {}, readOnly)).toBe("deny");
  });
});
