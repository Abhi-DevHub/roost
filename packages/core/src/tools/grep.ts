import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ToolError, resolvePath, displayPath, type Tool } from "./index.js";
import { walkFiles } from "./walk.js";

const GrepInput = z.object({
  pattern: z.string().min(1).describe("Regular expression to search for"),
  /** Directory or file to search; defaults to the worktree root. */
  path: z.string().optional(),
  /** Glob filter on file names, e.g. `*.ts`. */
  include: z.string().optional(),
});

function matchesGlob(name: string, pattern: string): boolean {
  let out = "";
  for (const ch of pattern) {
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`).test(name);
}

export const grepTool: Tool<typeof GrepInput> = {
  name: "grep",
  description: "Search file contents in the worktree for a regular expression (pure JS, no rg).",
  inputSchema: GrepInput,
  async execute(input, ctx) {
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern);
    } catch (err) {
      throw new ToolError(`invalid regex: ${err instanceof Error ? err.message : String(err)}`);
    }
    const base = input.path ? resolvePath(ctx.cwd, input.path) : ctx.cwd;
    const files = walkFiles(base).filter((f) => !input.include || matchesGlob(f, input.include));
    const lines: string[] = [];
    for (const file of files) {
      const abs = join(base, file);
      let content: string;
      try {
        content = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      content.split("\n").forEach((line, i) => {
        if (regex.test(line)) {
          lines.push(`${displayPath(ctx.cwd, abs)}:${i + 1}: ${line.trimEnd()}`);
        }
      });
      if (lines.length > 500) break; // ponytail: cap output; raise if full dumps matter
    }
    return lines.length === 0 ? "(no matches)" : lines.join("\n");
  },
};
