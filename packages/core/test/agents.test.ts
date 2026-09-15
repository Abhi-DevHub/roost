import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinAgents, loadAgents, getAgent, UnknownAgentError, InvalidAgentError } from "../src/index.js";

let root: string;
let agentsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "roost-agents-"));
  agentsDir = join(root, ".roost", "agents");
  mkdirSync(agentsDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeAgent(name: string, frontmatter: string, prompt: string): void {
  writeFileSync(join(agentsDir, `${name}.md`), `---\n${frontmatter}\n---\n${prompt}\n`);
}

describe("agents", () => {
  it("provides build/plan/explore built-ins", () => {
    const agents = builtinAgents();
    expect(agents.get("build")?.mode).toBe("primary");
    expect(agents.get("plan")?.mode).toBe("primary");
    expect(agents.get("explore")?.mode).toBe("subagent");
  });

  it("loadAgents returns built-ins when no agentsDir", () => {
    const agents = loadAgents({});
    expect(agents.get("build")).toBeDefined();
  });

  it("merges a custom agent file over built-ins (override by name)", () => {
    writeAgent(
      "plan",
      'name: plan\nmode: primary\npermission:\n  - tool: "read"\n    permission: allow\n',
      "You are a custom planner.",
    );
    const agents = loadAgents({ agentsDir });
    const plan = getAgent(agents, "plan");
    expect(plan.prompt).toContain("custom planner");
    expect(plan.permission).toEqual([{ tool: "read", permission: "allow" }]);
  });

  it("adds a new agent from a file", () => {
    writeAgent(
      "reviewer",
      'mode: subagent\nmodel: anthropic:claude-sonnet-4-5\npermission:\n  - tool: "*"\n    permission: deny\n',
      "You review diffs.",
    );
    const agents = loadAgents({ agentsDir });
    const reviewer = getAgent(agents, "reviewer");
    expect(reviewer.mode).toBe("subagent");
    expect(reviewer.model).toBe("anthropic:claude-sonnet-4-5");
    expect(reviewer.permission).toEqual([{ tool: "*", permission: "deny" }]);
  });

  it("unknown agent throws an explicit error", () => {
    const agents = loadAgents({ agentsDir });
    expect(() => getAgent(agents, "ghost")).toThrow(UnknownAgentError);
  });

  it("rejects a file with invalid frontmatter", () => {
    writeAgent("bad", "mode: not-a-mode\n", "x");
    expect(() => loadAgents({ agentsDir })).toThrow(InvalidAgentError);
  });

  it("rejects a file with no frontmatter", () => {
    writeFileSync(join(agentsDir, "nofm.md"), "just a prompt\n");
    expect(() => loadAgents({ agentsDir })).toThrow(InvalidAgentError);
  });
});
