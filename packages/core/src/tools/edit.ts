import { z } from "zod";
import { ToolError, resolvePath, displayPath, hostFor, type Tool } from "./index.js";

const EditInput = z.object({
  filePath: z.string().min(1).describe("Path of the file to edit, relative to the worktree"),
  oldString: z.string().min(1).describe("Exact text to replace (must occur exactly once)"),
  newString: z.string().describe("Replacement text"),
});

export const editTool: Tool<typeof EditInput> = {
  name: "edit",
  description: "Replace an exact string in a file. Fails if the string is missing or ambiguous.",
  inputSchema: EditInput,
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.filePath);
    const rel = displayPath(ctx.cwd, abs);
    const host = hostFor(ctx);
    let content: string;
    try {
      content = await host.readFile(abs);
    } catch (err) {
      throw new ToolError(`cannot read ${rel}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const first = content.indexOf(input.oldString);
    if (first === -1) {
      throw new ToolError(`edit failed: oldString not found in ${rel}`);
    }
    const second = content.indexOf(input.oldString, first + input.oldString.length);
    if (second !== -1) {
      throw new ToolError(`edit failed: oldString is ambiguous (occurs more than once) in ${rel}`);
    }

    const next = content.slice(0, first) + input.newString + content.slice(first + input.oldString.length);
    await host.writeFile(abs, next);
    return `edited ${rel}: replaced 1 occurrence`;
  },
};
