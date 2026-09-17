import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

export interface WorktreeInfo {
  /** Absolute path of the worktree. */
  worktree: string;
  /** HEAD sha (or "detached" note is dropped; head stays the sha). */
  head: string;
  /** Branch name (e.g. `roost/foo`) or "" when detached. */
  branch: string;
}

export interface RemoveResult {
  removed: boolean;
  branchDeleted: boolean;
  /** Non-null when the branch was kept (unmerged commits) rather than deleted. */
  branchPreservedReason: string | null;
}

interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runGit(cwd: string, args: string[]): GitResult {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

/** Windows paths are case-insensitive and git may report a differently-cased
 *  or 8.3-short form; realpath + lower-case so path lookups cannot silently miss. */
function canon(p: string): string {
  let abs: string;
  try {
    abs = realpathSync.native(p);
  } catch {
    abs = resolve(p);
  }
  abs = abs.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/**
 * Shells out to the `git` CLI (never isomorphic-git). All paths are passed as
 * arguments; there is no shell interpolation, so Windows (PowerShell/ConPTY)
 * and Linux behave identically.
 */
export class WorktreeManager {
  constructor(private readonly repoDir: string) {}

  /**
   * `git worktree add --no-track -b <branch> <path> <baseRef>`.
   * Throws with git's stderr on failure.
   */
  create(branch: string, path: string, baseRef: string): void {
    const r = runGit(this.repoDir, ["worktree", "add", "--no-track", "-b", branch, path, baseRef]);
    if (r.status !== 0) {
      throw new Error(`git worktree add failed: ${r.stderr.trim()}`);
    }
  }

  /** `git worktree list --porcelain -z`, parsed. */
  list(): WorktreeInfo[] {
    const r = runGit(this.repoDir, ["worktree", "list", "--porcelain", "-z"]);
    if (r.status !== 0) {
      throw new Error(`git worktree list failed: ${r.stderr.trim()}`);
    }
    return parsePorcelainZ(r.stdout);
  }

  /**
   * `git worktree remove [--force] <path>`; if the directory is already gone,
   * this is a no-op followed by `git worktree prune`. After removal the branch
   * is deleted with `git branch -d` (safe delete); an unmerged branch is
   * preserved and reported instead of being lost.
   */
  remove(path: string, opts: { force?: boolean } = {}): RemoveResult {
    const target = canon(path);
    const before = this.list().find((w) => canon(w.worktree) === target);

    if (!existsSync(target)) {
      runGit(this.repoDir, ["worktree", "prune"]);
      return { removed: false, branchDeleted: false, branchPreservedReason: null };
    }

    const args = ["worktree", "remove"];
    if (opts.force) args.push("--force");
    args.push(target);
    const r = runGit(this.repoDir, args);
    if (r.status !== 0) {
      throw new Error(`git worktree remove failed: ${r.stderr.trim()}`);
    }
    runGit(this.repoDir, ["worktree", "prune"]);

    let branchDeleted = false;
    let branchPreservedReason: string | null = null;
    if (before && before.branch) {
      const bd = runGit(this.repoDir, ["branch", "-d", before.branch]);
      if (bd.status === 0) {
        branchDeleted = true;
      } else {
        branchPreservedReason = `branch ${before.branch} has unmerged commits; preserved`;
      }
    }

    return { removed: true, branchDeleted, branchPreservedReason };
  }
}

/** Parse `git worktree list --porcelain -z` output into `WorktreeInfo[]`. */
function parsePorcelainZ(output: string): WorktreeInfo[] {
  const records = output.split("\0");
  const result: WorktreeInfo[] = [];
  let path = "";
  let head = "";
  let branch = "";

  const flush = () => {
    if (path) {
      result.push({ worktree: path, head, branch });
      path = "";
      head = "";
      branch = "";
    }
  };

  for (const record of records) {
    if (record === "") {
      flush();
    } else if (record.startsWith("worktree ")) {
      path = record.slice("worktree ".length);
    } else if (record.startsWith("HEAD ")) {
      head = record.slice("HEAD ".length);
    } else if (record.startsWith("branch ")) {
      branch = record.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (record === "detached") {
      branch = "";
    } else if (record === "locked") {
      // ignore; not modeled in Phase 0
    }
  }
  flush();
  return result;
}
