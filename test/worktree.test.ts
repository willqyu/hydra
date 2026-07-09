import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Git } from "../src/git.js";
import { WorktreeManager, BranchBusyError } from "../src/worktree.js";

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hydra-wt-"));
  const git = new Git(dir);
  await git.run(["init", "-b", "main"]);
  await git.run(["config", "user.email", "test@example.com"]);
  await git.run(["config", "user.name", "Hydra Test"]);
  await writeFile(path.join(dir, "README.md"), "# base\n");
  await git.run(["add", "."]);
  await git.run(["commit", "-m", "init"]);
  return dir;
}

test("add creates a worktree on a fresh branch", async () => {
  const repo = await initRepo();
  try {
    const wtm = new WorktreeManager(repo, path.join(repo, ".hydra", "worktrees"));
    const base = await new Git(repo).head();
    const wt = await wtm.add("feat/a", base);
    assert.ok((await wtm.list()).some((w) => w.branch === "feat/a" && w.path === wt));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("add throws BranchBusyError when a live worktree already owns the branch", async () => {
  const repo = await initRepo();
  try {
    const wtm = new WorktreeManager(repo, path.join(repo, ".hydra", "worktrees"));
    const base = await new Git(repo).head();
    await wtm.add("feat/dup", base); // first (winning) worker holds it
    // A duplicate/concurrent spawn for the same branch must not hard-fail or
    // clobber — it bows out with a typed signal.
    await assert.rejects(() => wtm.add("feat/dup", base), BranchBusyError);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("add attaches to an existing branch with no live worktree (re-spawn continues)", async () => {
  const repo = await initRepo();
  try {
    const wtm = new WorktreeManager(repo, path.join(repo, ".hydra", "worktrees"));
    const base = await new Git(repo).head();
    // Simulate a prior finished run: branch exists with a commit, worktree gone.
    const first = await wtm.add("feat/resume", base);
    const fg = new Git(first);
    await writeFile(path.join(first, "work.txt"), "done\n");
    await fg.run(["add", "-A"]);
    await fg.run(["commit", "-m", "prior work"]);
    const tip = await fg.head();
    await wtm.remove("feat/resume", { force: true });

    // Re-adding must attach to the existing branch (preserving its commit), not fail.
    const wt = await wtm.add("feat/resume", base);
    assert.equal(await new Git(wt).head(), tip, "attached to the existing branch's tip");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
