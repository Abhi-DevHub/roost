import { resolve, relative } from "node:path";
import type { z } from "zod";
import { LocalHost, type Host } from "../hosts.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { bashTool } from "./bash.js";
import { grepTool } from "./grep.js";
import { globTool } from "./glob.js";
import { lsTool } from "./ls.js";

// ---------------------------------------------------------------------------
// Tool registry — the native loop's tools. Each tool declares a Zod input
// schema and an `execute` that runs against the worktree (`ctx.cwd`) on the
// thread's host (`ctx.host`, defaulting to local) and returns a plain-text
// result. Failures throw `ToolError` (→ error result).
// ---------------------------------------------------------------------------

export interface ToolContext {
  /** Working directory the tool operates in (the thread's worktree). */
  cwd: string;
  /** Execution host; defaults to local when the thread targets no remote host. */
  host?: Host;
}

const localHost = new LocalHost();

/** The host a tool runs on: the thread's host, or local. */
export function hostFor(ctx: ToolContext): Host {
  return ctx.host ?? localHost;
}

export interface Tool<TSchema extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  inputSchema: TSchema;
  execute(input: z.infer<TSchema>, ctx: ToolContext): Promise<string>;
}

/** A tool failed to run; the message becomes the tool error result. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export class UnknownToolError extends Error {
  constructor(name: string) {
    super(`unknown tool: ${name}`);
    this.name = "UnknownToolError";
  }
}

/** Resolve a tool path argument against the worktree. */
export function resolvePath(cwd: string, p: string): string {
  return resolve(cwd, p);
}

/** A path relative to the worktree (for display), or the absolute path. */
export function displayPath(cwd: string, abs: string): string {
  const rel = relative(cwd, abs);
  return rel === "" ? "." : rel;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** All registered tools. */
  all(): Tool[] {
    return [...this.tools.values()];
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
}

/** The built-in tool set (read/write/edit/bash/grep/glob/ls). */
export function builtinTools(): ToolRegistry {
  return new ToolRegistry()
    .register(readTool)
    .register(writeTool)
    .register(editTool)
    .register(bashTool)
    .register(grepTool)
    .register(globTool)
    .register(lsTool);
}

/** Validate `input` against a tool's schema and run it, normalizing errors. */
export async function runTool(
  tool: Tool,
  input: unknown,
  ctx: ToolContext,
): Promise<{ ok: boolean; text: string }> {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, text: `invalid input for ${tool.name}: ${detail}` };
  }
  try {
    const text = await tool.execute(parsed.data, ctx);
    return { ok: true, text };
  } catch (err) {
    return { ok: false, text: err instanceof Error ? err.message : String(err) };
  }
}
