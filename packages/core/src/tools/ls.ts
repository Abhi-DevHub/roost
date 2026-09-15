import { z } from "zod";
import { ToolError, resolvePath, displayPath, hostFor, type Tool } from "./index.js";

const LsInput = z.object({
  /** Directory to list; defaults to the worktree root. */
  path: z.string().optional(),
});

export const lsTool: Tool<typeof LsInput> = {
  name: "ls",
  description: "List the entries of a directory in the worktree.",
  inputSchema: LsInput,
  async execute(input, ctx) {
    const abs = input.path ? resolvePath(ctx.cwd, input.path) : ctx.cwd;
    let entries: { name: string; isDirectory: boolean }[];
    try {
      entries = await hostFor(ctx).listDir(abs);
    } catch (err) {
      throw new ToolError(`cannot list ${displayPath(ctx.cwd, abs)}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const rows = entries.map((e) => `${e.isDirectory ? "d" : "-"} ${e.name}`).sort();
    return rows.length === 0 ? "(empty directory)" : rows.join("\n");
  },
};
