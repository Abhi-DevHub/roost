import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { allowAll, readOnly, type Ruleset } from "./permissions.js";

// ---------------------------------------------------------------------------
// Agents as data. Built-ins are permission merges (build = full access,
// plan/explore = read-only); `.roost/agents/*.md` (YAML frontmatter + markdown
// prompt) override or extend them. Unknown agent → explicit error.
// ---------------------------------------------------------------------------

export interface Agent {
  name: string;
  mode: "primary" | "subagent";
  model?: string;
  permission: Ruleset;
  prompt: string;
}

export class UnknownAgentError extends Error {
  constructor(name: string) {
    super(`unknown agent: ${name}`);
    this.name = "UnknownAgentError";
  }
}

export class InvalidAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAgentError";
  }
}

const PermissionRuleSchema = z.object({
  tool: z.string().min(1),
  permission: z.enum(["allow", "ask", "deny"]),
});

const FrontmatterSchema = z.object({
  name: z.string().min(1).optional(),
  mode: z.enum(["primary", "subagent"]).optional(),
  model: z.string().min(1).optional(),
  permission: z.array(PermissionRuleSchema).optional(),
});

const BUILTIN_PROMPTS = {
  build:
    "You are Roost's build agent. You plan and implement code changes in the worktree, using the available tools to inspect, edit, and test. Prefer small, correct changes.",
  plan:
    "You are Roost's plan agent. You are read-only: inspect the codebase and produce a concrete plan, but never modify files or run commands.",
  explore:
    "You are Roost's explore agent. You are a read-only subagent that investigates the codebase and reports findings concisely.",
} as const;

/** The built-in agents. */
export function builtinAgents(): Map<string, Agent> {
  return new Map<string, Agent>([
    ["build", { name: "build", mode: "primary", permission: allowAll, prompt: BUILTIN_PROMPTS.build }],
    ["plan", { name: "plan", mode: "primary", permission: readOnly, prompt: BUILTIN_PROMPTS.plan }],
    ["explore", { name: "explore", mode: "subagent", permission: readOnly, prompt: BUILTIN_PROMPTS.explore }],
  ]);
}

/** Split an agent markdown file into `{ frontmatter, prompt }`. */
function parseAgentFile(text: string, source: string): { frontmatter: Record<string, unknown>; prompt: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) {
    throw new InvalidAgentError(`agent file ${source} has no YAML frontmatter (--- ... ---)`);
  }
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(match[1]!);
  } catch (err) {
    throw new InvalidAgentError(`invalid YAML frontmatter in ${source}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (frontmatter == null || typeof frontmatter !== "object") {
    throw new InvalidAgentError(`agent file ${source} has empty frontmatter`);
  }
  return { frontmatter: frontmatter as Record<string, unknown>, prompt: match[2]!.trim() };
}

export interface LoadAgentsInput {
  /** Directory holding `*.md` agent definitions; skipped if missing. */
  agentsDir?: string;
}

/**
 * Load agents: built-ins first, then every `*.md` in `agentsDir` (sorted by
 * name) parsed and applied over them by name.
 */
export function loadAgents(input: LoadAgentsInput = {}): Map<string, Agent> {
  const agents = builtinAgents();
  if (!input.agentsDir) return agents;

  let files: string[];
  try {
    files = readdirSync(input.agentsDir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return agents;
  }
  for (const file of files) {
    const source = join(input.agentsDir, file);
    const { frontmatter, prompt } = parseAgentFile(readFileSync(source, "utf8"), source);
    const parsed = FrontmatterSchema.safeParse(frontmatter);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`).join("; ");
      throw new InvalidAgentError(`invalid agent ${source}: ${detail}`);
    }
    const name = parsed.data.name ?? basename(file, ".md");
    const existing = agents.get(name);
    agents.set(name, {
      name,
      mode: parsed.data.mode ?? existing?.mode ?? "primary",
      model: parsed.data.model ?? existing?.model,
      permission: parsed.data.permission ?? existing?.permission ?? allowAll,
      prompt: prompt || existing?.prompt || "",
    });
  }
  return agents;
}

/** Resolve an agent by name from a loaded map. Unknown → explicit error. */
export function getAgent(agents: Map<string, Agent>, name: string): Agent {
  const agent = agents.get(name);
  if (!agent) throw new UnknownAgentError(name);
  return agent;
}
