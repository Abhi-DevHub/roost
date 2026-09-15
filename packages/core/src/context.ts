import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { roostHome } from "./config.js";

// ---------------------------------------------------------------------------
// Context files — the `AGENTS.md` hierarchy, concatenated in order:
// global `~/.roost/AGENTS.md` → each parent directory (root → cwd) → cwd.
// ---------------------------------------------------------------------------

/** Directories from the filesystem root down to `dir`, inclusive. */
function ancestors(dir: string): string[] {
  const dirs: string[] = [];
  let cur = resolve(dir);
  for (;;) {
    dirs.unshift(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dirs;
}

export interface LoadContextInput {
  /** Directory whose AGENTS.md hierarchy to load (typically the worktree). */
  cwd: string;
  /** Global context file; defaults to `$ROOST_HOME/AGENTS.md`. */
  globalFile?: string;
}

/** Concatenate the AGENTS.md hierarchy for a directory into one string. */
export function loadContext(input: LoadContextInput): string {
  const files: string[] = [];
  const global = input.globalFile ?? join(roostHome(), "AGENTS.md");
  if (existsSync(global)) files.push(global);
  for (const dir of ancestors(input.cwd)) {
    const f = join(dir, "AGENTS.md");
    if (existsSync(f)) files.push(f);
  }
  return files
    .map((f) => `<!-- ${f} -->\n${readFileSync(f, "utf8").trim()}`)
    .join("\n\n");
}
