import { z } from "zod";
import { resolvePath, type Tool } from "./index.js";
import { walkFiles } from "./walk.js";

const GlobInput = z.object({
  pattern: z.string().min(1).describe("Glob pattern (`*`, `**`, `?`), e.g. `src/**/*.ts`"),
  /** Directory to search; defaults to the worktree root. */
  path: z.string().optional(),
});

/** Match a relative path against a glob pattern supporting `*`, `**`, `?`. */
export function globMatch(pattern: string, path: string): boolean {
  const segs = pattern.split("/").filter((s) => s !== "**");
  const re = segs
    .map((s) => {
      let out = "";
      for (const ch of s) {
        if (ch === "*") out += "[^/]*";
        else if (ch === "?") out += "[^/]";
        else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
      return out;
    })
    .join("/");
  return new RegExp(`^${re}$`).test(path);
}

export const globTool: Tool<typeof GlobInput> = {
  name: "glob",
  description: "List files in the worktree matching a glob pattern (pure JS).",
  inputSchema: GlobInput,
  async execute(input, ctx) {
    const base = input.path ? resolvePath(ctx.cwd, input.path) : ctx.cwd;
    const normalized = input.pattern.replace(/\\/g, "/");
    const files = walkFiles(base).map((f) => f.replace(/\\/g, "/")).filter((f) => globMatch(normalized, f));
    return files.length === 0 ? "(no matches)" : files.join("\n");
  },
};
