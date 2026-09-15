import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".roost"]);

/**
 * Recursively walk a directory (relative to `base`), yielding relative paths
 * of regular files, skipping noisy/irrelevant directories. Pure Node fs.
 */
export function walkFiles(base: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry);
      let isDir: boolean;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (SKIP_DIRS.has(entry)) continue;
        visit(abs);
      } else {
        out.push(relative(base, abs));
      }
    }
  };
  visit(resolve(base));
  return out;
}
