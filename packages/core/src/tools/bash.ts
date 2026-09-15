import { z } from "zod";
import { hostFor, type Tool } from "./index.js";

const BashInput = z.object({
  command: z.string().min(1).describe("Shell command to run in the worktree"),
});

function formatResult(
  res: { exitCode: number; stdout: string; stderr: string; timedOut: boolean },
  timeoutMs: number,
): string {
  const body = `${res.stdout}${res.stderr}`.trim();
  const suffix = res.timedOut
    ? `\n[timed out after ${timeoutMs}ms]`
    : res.exitCode === 0
      ? ""
      : `\n[exit code ${res.exitCode}]`;
  return `${body}${suffix}`.trim();
}

export const bashTool: Tool<typeof BashInput> = {
  name: "bash",
  description:
    "Run a shell command in the worktree (platform shell locally; the remote shell on an SSH host).",
  inputSchema: BashInput,
  async execute(input, ctx) {
    const res = await hostFor(ctx).runCommand(input.command, { cwd: ctx.cwd, timeoutMs: 30_000 });
    return formatResult(res, 30_000);
  },
};
