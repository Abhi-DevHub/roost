import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Custom slash commands — `.roost/commands/*.md` with YAML frontmatter
// (`description`) and a body that supports `$ARGUMENTS` and `$1`..`$9`.
// ---------------------------------------------------------------------------

export interface CommandDef {
  name: string;
  description: string;
  body: string;
  source: string;
}

export class InvalidCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCommandError";
  }
}

const FrontmatterSchema = z.object({
  description: z.string().min(1),
});

export function parseCommandFile(text: string, source: string, name: string): CommandDef {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) {
    throw new InvalidCommandError(`command file ${source} has no YAML frontmatter (--- ... ---)`);
  }
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(match[1]!);
  } catch (err) {
    throw new InvalidCommandError(
      `invalid YAML frontmatter in ${source}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = FrontmatterSchema.safeParse(frontmatter);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("; ");
    throw new InvalidCommandError(`invalid command ${source}: ${detail}`);
  }
  return { name, description: parsed.data.description, body: match[2]!.trim(), source };
}

/** Load every `*.md` in a commands directory (missing dir → empty). */
export function discoverCommands(commandsDir: string): CommandDef[] {
  let files: string[];
  try {
    files = readdirSync(commandsDir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
  return files.map((f) => {
    const source = join(commandsDir, f);
    return parseCommandFile(readFileSync(source, "utf8"), source, basename(f, ".md"));
  });
}

/** The commands directory for a project root. */
export function commandsDirFor(projectRoot: string): string {
  return join(projectRoot, ".roost", "commands");
}

/**
 * Expand a command body: `$ARGUMENTS` → all args joined, `$1`..`$9` → the Nth
 * arg (empty when missing).
 */
export function expandCommand(body: string, args: string[]): string {
  const all = args.join(" ");
  return body.replace(/\$ARGUMENTS\b/g, all).replace(/\$([1-9])/g, (_m, d: string) => args[Number(d) - 1] ?? "");
}

/** The full turn prompt for a command: its description + expanded body. */
export function commandPrompt(def: CommandDef, args: string[]): string {
  return expandCommand(def.body, args);
}
