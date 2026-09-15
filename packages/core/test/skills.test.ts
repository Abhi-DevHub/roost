import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverSkills,
  skillTool,
  formatSkillsForPrompt,
  UnknownSkillError,
  InvalidSkillError,
  runTool,
} from "../src/index.js";

let root: string;
let userDir: string;
let cwd: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "roost-skills-"));
  userDir = join(root, "user", "skills");
  cwd = join(root, "proj");
  mkdirSync(userDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeSkill(dir: string, name: string, description: string, body?: string): void {
  mkdirSync(dir, { recursive: true });
  const text = body ?? `body of ${name}`;
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n${text}\n`);
}

describe("discoverSkills", () => {
  it("discovers skills from project + user dirs, body loaded on demand", async () => {
    writeSkill(join(userDir, "shared"), "shared", "user shared skill");
    writeSkill(join(cwd, ".claude", "skills", "claude-skill"), "claude-skill", "from claude");
    writeSkill(join(cwd, ".agents", "skills", "agent-skill"), "agent-skill", "from agents");

    const { skills, warnings } = discoverSkills({ cwd, userSkillsDir: userDir });
    const names = skills.map((s) => s.name);
    expect(names).toContain("shared");
    expect(names).toContain("claude-skill");
    expect(names).toContain("agent-skill");
    expect(warnings).toEqual([]);

    const tool = skillTool(skills);
    const result = await runTool(tool, { name: "claude-skill" }, { cwd });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("body of claude-skill");
  });

  it("progressive disclosure: listing carries name+description, not the body", () => {
    writeSkill(join(cwd, ".roost", "skills", "big"), "big", "does big things", "a very long secret body");
    const { skills } = discoverSkills({ cwd, userSkillsDir: userDir });
    const prompt = formatSkillsForPrompt(skills);
    expect(prompt).toContain("big: does big things");
    expect(prompt).not.toContain("secret body");
  });

  it("project skill overrides a user skill with an explicit warning", () => {
    writeSkill(join(userDir, "dup"), "dup", "user version", "user body");
    writeSkill(join(cwd, ".claude", "skills", "dup"), "dup", "project version", "project body");

    const { skills, warnings } = discoverSkills({ cwd, userSkillsDir: userDir });
    const dup = skills.find((s) => s.name === "dup");
    expect(dup?.description).toBe("project version");
    expect(dup?.body).toBe("project body");
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/dup.*overrides.*user/i);
  });

  it("unknown skill throws an explicit error", async () => {
    writeSkill(join(cwd, ".roost", "skills", "known"), "known", "known skill");
    const { skills } = discoverSkills({ cwd, userSkillsDir: userDir });
    const tool = skillTool(skills);
    const result = await runTool(tool, { name: "ghost" }, { cwd });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/unknown skill: ghost/);
    await expect(tool.execute({ name: "ghost" }, { cwd })).rejects.toThrow(UnknownSkillError);
  });

  it("rejects a SKILL.md without valid frontmatter", () => {
    mkdirSync(join(cwd, ".roost", "skills", "bad"), { recursive: true });
    writeFileSync(join(cwd, ".roost", "skills", "bad", "SKILL.md"), "no frontmatter here\n");
    expect(() => discoverSkills({ cwd, userSkillsDir: userDir })).toThrow(InvalidSkillError);
  });
});
