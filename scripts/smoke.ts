import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { OrchestrationEngine, WorktreeManager } from "@roost/core";
import type { Command as RoostCommand } from "@roost/contracts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function now(): string {
  return new Date().toISOString();
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "roost-smoke-"));
  const repo = join(root, "repo");
  const stateDir = join(root, "state");
  const worktreesDir = join(root, "worktrees");
  mkdirSync(repo, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(worktreesDir, { recursive: true });

  try {
    // 1. Init a real git repo with one commit so `HEAD` resolves.
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "roost@example.com"]);
    git(repo, ["config", "user.name", "Roost"]);
    writeFileSync(join(repo, "README.md"), "# repo\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "init"]);

    const engine = new OrchestrationEngine({
      dbPath: join(stateDir, "roost.db"),
      worktreesDir,
    });

    // 2. Register a project.
    const projectCreate: RoostCommand = {
      type: "project.create",
      projectId: randomUUID(),
      title: "repo",
      workspaceRoot: repo,
      commandId: randomUUID(),
      createdAt: now(),
    };
    await engine.dispatch(projectCreate);
    assert.equal(engine.getReadModel().projects.length, 1, "project registered");

    // 3. Create a worktree (decide plans branch/path; git materializes it).
    const worktreeCreate: RoostCommand = {
      type: "worktree.create",
      worktreeId: randomUUID(),
      projectId: projectCreate.projectId,
      name: "fix-thing",
      baseRef: "HEAD",
      commandId: randomUUID(),
      createdAt: now(),
    };
    const created = await engine.dispatch(worktreeCreate);
    const createdEvent = created.events.find((e) => e.type === "worktree.created");
    assert.ok(createdEvent && createdEvent.type === "worktree.created", "worktree.created event");
    new WorktreeManager(repo).create(createdEvent.payload.branch, createdEvent.payload.path, createdEvent.payload.baseRef);

    // 4. Worktree is on disk and in git + read model.
    assert.ok(existsSync(createdEvent.payload.path), "worktree dir exists on disk");
    const gitList = new WorktreeManager(repo).list();
    assert.ok(
      gitList.some((w) => w.branch === createdEvent.payload.branch),
      "worktree visible in git worktree list",
    );
    assert.equal(engine.getReadModel().worktrees.length, 1, "worktree in read model");

    // 5. Idempotent replay: same commandId → one event, stored sequence.
    const replayed = await engine.dispatch(worktreeCreate);
    assert.deepEqual(replayed.events, [], "replay emits nothing");
    assert.equal(replayed.sequence, created.sequence, "replay returns stored sequence");
    assert.equal(engine.getReadModel().worktrees.length, 1, "no duplicate worktree on replay");
    await engine.dispatch(projectCreate).then((r) => {
      assert.equal(r.sequence, 1, "project replay returns stored sequence");
    });
    assert.equal(engine.getReadModel().projects.length, 1, "no duplicate project on replay");

    // 6. Remove the worktree.
    const worktreeRemove: RoostCommand = {
      type: "worktree.remove",
      worktreeId: worktreeCreate.worktreeId,
      commandId: randomUUID(),
      createdAt: now(),
    };
    await engine.dispatch(worktreeRemove);
    const removeResult = new WorktreeManager(repo).remove(createdEvent.payload.path, { force: true });
    assert.equal(removeResult.removed, true, "worktree removed from disk");
    assert.ok(!existsSync(createdEvent.payload.path), "worktree dir gone");
    assert.equal(engine.getReadModel().worktrees.length, 0, "worktree removed from read model");

    // 7. Idempotent remove replay.
    await engine.dispatch(worktreeRemove).then((r) => {
      assert.deepEqual(r.events, [], "remove replay emits nothing");
    });

    // 8. Rebuild read model from the event log (replay) and confirm parity.
    engine.close();
    const reopened = new OrchestrationEngine({ dbPath: join(stateDir, "roost.db"), worktreesDir });
    assert.equal(reopened.getReadModel().projects.length, 1, "project persisted across reopen");
    assert.equal(reopened.getReadModel().worktrees.length, 0, "worktree removed across reopen");
    reopened.close();

    console.log("SMOKE OK: register → create → list → remove → idempotent replay, all persisted.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err);
  process.exit(1);
});
