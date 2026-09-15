import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { roostHome } from "./config.js";
import type { Tool } from "./tools/index.js";

// ---------------------------------------------------------------------------
// Skills — Claude-Code-compatible `SKILL.md` files. Discovered from project
// (`.roost/skills`, `.claude/skills`, `.agents/skills`) and user
// (`~/.roost/skills`) directories. Progressive disclosure: only name +
// description go into the system prompt; the body loads on demand via the
// `skill` tool. Duplicate names → project wins with an explicit warning.
// ---------------------------------------------------------------------------

export interface Skill {
  name: string;
  description: string;
  body: string;
  source: string;
}

export interface SkillsResult {
  skills: Skill[];
  warnings: string[];
}

export class UnknownSkillError extends Error {
  constructor(name: string) {
    super(`unknown skill: ${name}`);
    this.name = "UnknownSkillError";
  }
}

export class InvalidSkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSkillError";
  }
}

const FrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
});

export interface DiscoverSkillsInput {
  /** Directory searched for `.roost/skills`, `.claude/skills`, `.agents/skills`. */
  cwd?: string;
  /** User skills dir; defaults to `$ROOST_HOME/skills`. */
  userSkillsDir?: string;
}

/** Recursively list `SKILL.md` files (any case) under `dir`. */
function findSkillFiles(dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(d, entry);
      let isDir: boolean;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
        visit(abs);
      } else if (basename(abs).toLowerCase() === "skill.md") {
        out.push(abs);
      }
    }
  };
  visit(dir);
  return out;
}

function parseSkillFile(text: string, source: string): Skill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) {
    throw new InvalidSkillError(`skill file ${source} has no YAML frontmatter (--- ... ---)`);
  }
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(match[1]!);
  } catch (err) {
    throw new InvalidSkillError(
      `invalid YAML frontmatter in ${source}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = FrontmatterSchema.safeParse(frontmatter);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("; ");
    throw new InvalidSkillError(`invalid skill ${source}: ${detail}`);
  }
  return {
    name: parsed.data.name,
    description: parsed.data.description,
    body: match[2]!.trim(),
    source,
  };
}

/**
 * Discover and merge skills. Project skills (from `cwd`) override user skills
 * on a name collision; every override and within-layer duplicate is reported
 * as a warning. Sorting is deterministic (by name, then source).
 */
export function discoverSkills(input: DiscoverSkillsInput = {}): SkillsResult {
  const warnings: string[] = [];
  const byName = new Map<string, { skill: Skill; layer: "user" | "project" }>();

  const merge = (files: string[], layer: "user" | "project"): void => {
    for (const file of [...files].sort()) {
      const skill = parseSkillFile(readFileSync(file, "utf8"), file);
      const existing = byName.get(skill.name);
      if (!existing) {
        byName.set(skill.name, { skill, layer });
      } else if (existing.layer === "user" && layer === "project") {
        warnings.push(`skill "${skill.name}": project ${skill.source} overrides user ${existing.skill.source}`);
        byName.set(skill.name, { skill, layer });
      } else {
        warnings.push(`skill "${skill.name}": duplicate in ${existing.skill.source} and ${skill.source}; keeping ${existing.skill.source}`);
      }
    }
  };

  const userDir = input.userSkillsDir ?? join(roostHome(), "skills");
  merge(findSkillFiles(userDir), "user");

  if (input.cwd) {
    for (const sub of [".agents", ".claude", ".roost"]) {
      merge(findSkillFiles(join(input.cwd, sub, "skills")), "project");
    }
  }

  const skills = [...byName.values()]
    .map((e) => e.skill)
    .sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
  return { skills, warnings };
}

/** The `skill` tool: loads a discovered skill's body on demand. */
export function skillTool(skills: Skill[]): Tool {
  return {
    name: "skill",
    description:
      "Load the full instructions of a discovered skill by name. Use to read a skill's body on demand.",
    inputSchema: z.object({ name: z.string().min(1) }),
    async execute(input) {
      const skill = skills.find((s) => s.name === input.name);
      if (!skill) throw new UnknownSkillError(input.name);
      return skill.body;
    },
  };
}

/** A compact `name: description` listing for the system prompt. */
export function formatSkillsForPrompt(skills: Skill[]): string {
  return skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
}
