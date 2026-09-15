import { z } from "zod";
import { ToolError, resolvePath, displayPath, hostFor, type Tool } from "./index.js";

const ReadInput = z.object({
  filePath: z.string().min(1).describe("Path of the file to read, relative to the worktree"),
  /** 0-based line offset (inclusive). */
  offset: z.number().int().nonnegative().optional(),
  /** Max number of lines to return. */
  limit: z.number().int().positive().optional(),
});

export const readTool: Tool<typeof ReadInput> = {
  name: "read",
  description: "Read a text file from the worktree and return its contents.",
  inputSchema: ReadInput,
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.filePath);
    let content: string;
    try {
      content = await hostFor(ctx).readFile(abs);
    } catch (err) {
      throw new ToolError(`cannot read ${displayPath(ctx.cwd, abs)}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (input.offset === undefined && input.limit === undefined) {
      return content;
    }
    const lines = content.split("\n");
    const start = input.offset ?? 0;
    const end = input.limit === undefined ? lines.length : start + input.limit;
    const slice = lines.slice(start, end).join("\n");
    return `[${displayPath(ctx.cwd, abs)} lines ${start}-${Math.min(end, lines.length)} of ${lines.length}]\n${slice}`;
  },
};
