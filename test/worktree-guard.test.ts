import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Git } from "../src/git.js";
import {
  bashWorkingDir,
  isInsideWorktree,
  snapshotPrimary,
  strayCommits,
  sanityCheckResult,
} from "../src/worktree-guard.js";

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-guard-"));
  const git = new Git(dir);
  await git.run(["init", "-b", "main"]);
  await git.run(["config", "user.email", "test@example.com"]);
  await git.run(["config", "user.name", "Harness Test"]);
  await writeFile(path.join(dir, "README.md"), "# base\n");
  await git.run(["add", "."]);
  await git.run(["commit", "-m", "init"]);
  return dir;
}

test("bashWorkingDir extracts an escaping `cd` target", () => {
  const wt = "/home/u/repo/.harness/worktrees/feat_x";
  // No cd → runs in the worktree.
  assert.equal(bashWorkingDir("git commit -m hi", wt), wt);
  // cd to the primary checkout → that absolute path wins.
  assert.equal(bashWorkingDir("cd /home/u/repo && git commit -m hi", wt), "/home/u/repo");
  // Relative cd resolves against the worktree (still inside).
  assert.equal(bashWorkingDir("cd src && ls", wt), path.join(wt, "src"));
  // Quoted target.
  assert.equal(bashWorkingDir("cd '/home/u/repo/frontend' && npm t", wt), "/home/u/repo/frontend");
});

test("isInsideWorktree distinguishes inside vs escaped dirs", () => {
  const wt = "/home/u/repo/.harness/worktrees/feat_x";
  assert.equal(isInsideWorktree(wt, wt), true);
  assert.equal(isInsideWorktree(path.join(wt, "src/app"), wt), true);
  assert.equal(isInsideWorktree("/home/u/repo", wt), false);
  assert.equal(isInsideWorktree("/home/u/repo/frontend", wt), false);
});

test("strayCommits catches a commit made on the primary checkout after the snapshot", async () => {
  const repo = await initRepo();
  try {
    const git = new Git(repo);
    const snap = await snapshotPrimary(repo);
    assert.equal(snap.branch, "main");
    assert.deepEqual(await strayCommits(repo, snap), []); // nothing yet

    // Simulate an escaped agent committing straight onto the primary checkout.
    await writeFile(path.join(repo, "escaped.txt"), "oops\n");
    await git.run(["add", "."]);
    await git.run(["commit", "-m", "work that should have been on a branch"]);

    const stray = await strayCommits(repo, snap);
    assert.equal(stray.length, 1);
    assert.equal(stray[0]?.subject, "work that should have been on a branch");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("sanityCheckResult reports an escaped run instead of a misleading 'no commits'", () => {
  const stray = [{ sha: "abcdef1234", subject: "x" }];
  // Branch advanced → plain success even if something also strayed.
  const ok = sanityCheckResult({ branch: "feat/x", before: "a", head: "b", stray: [], primaryBranch: "main" });
  assert.equal(ok.ok, true);
  // Branch empty AND commits strayed → escape error naming the SHAs.
  const escaped = sanityCheckResult({ branch: "feat/x", before: "a", head: "a", stray, primaryBranch: "main" });
  assert.equal(escaped.ok, false);
  assert.match((escaped as { error: string }).error, /OUTSIDE its worktree/);
  assert.match((escaped as { error: string }).error, /abcdef12/);
  // Branch empty and nothing strayed → the original message.
  const empty = sanityCheckResult({ branch: "feat/x", before: "a", head: "a", stray: [], primaryBranch: "main" });
  assert.equal(empty.ok, false);
  assert.equal((empty as { error: string }).error, "agent produced no commits");
});
