import { z } from "zod";
import { resolvePath, displayPath, hostFor, type Tool } from "./index.js";

const WriteInput = z.object({
  filePath: z.string().min(1).describe("Path of the file to write, relative to the worktree"),
  content: z.string().describe("Full new contents of the file"),
});

export const writeTool: Tool<typeof WriteInput> = {
  name: "write",
  description: "Create or overwrite a file in the worktree (creates parent directories).",
  inputSchema: WriteInput,
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.filePath);
    await hostFor(ctx).writeFile(abs, input.content);
    return `wrote ${Buffer.byteLength(input.content, "utf8")} bytes to ${displayPath(ctx.cwd, abs)}`;
  },
};
