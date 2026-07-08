import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Git } from "../src/git.js";
import { Orchestrator } from "../src/orchestrator.js";
import { ScriptWorkerRunner, type WorkerFn } from "../src/worker.js";
import { Integrator } from "../src/integrator.js";
import { MergeTool } from "../src/merge.js";
import { WorktreeManager } from "../src/worktree.js";

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-m2-"));
  const git = new Git(dir);
  await git.run(["init", "-b", "main"]);
  await git.run(["config", "user.email", "test@example.com"]);
  await git.run(["config", "user.name", "Harness Test"]);
  await writeFile(path.join(dir, "README.md"), "# base\n");
  await git.run(["add", "."]);
  await git.run(["commit", "-m", "init"]);
  return dir;
}

function commitFile(file: string, contents: string, message: string): WorkerFn {
  return async (ctx) => {
    await writeFile(path.join(ctx.worktree, file), contents);
    await ctx.git.run(["add", "."]);
    await ctx.git.run(["commit", "-m", message]);
  };
}

test("non-conflicting branches land on main through the merge train", async () => {
  const repo = await initRepo();
  try {
    const runner = new ScriptWorkerRunner({
      a: commitFile("a.txt", "from A\n", "task a"),
      b: commitFile("b.txt", "from B\n", "task b"),
    });
    await new Orchestrator({ repoRoot: repo, runner, concurrency: 2 }).run([
      { id: "a", branch: "feat/a", description: "A" },
      { id: "b", branch: "feat/b", description: "B" },
    ]);

    const integ = new Integrator({ repoRoot: repo, testCommand: "git --version" });
    const result = await integ.integrate(["feat/a", "feat/b"]);

    assert.equal(result.promoted, true);
    assert.deepEqual(
      result.steps.map((s) => s.status),
      ["merged", "merged"],
    );

    const git = new Git(repo);
    assert.equal(await git.run(["show", "main:a.txt"]), "from A");
    assert.equal(await git.run(["show", "main:b.txt"]), "from B");

    // staging worktree cleaned up — only main remains
    const wtm = new WorktreeManager(repo, path.join(repo, ".harness", "worktrees"));
    assert.equal((await wtm.list()).length, 1);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("integrates into a NEW target branch, forked off the trunk, leaving main untouched", async () => {
  const repo = await initRepo();
  try {
    const runner = new ScriptWorkerRunner({
      a: commitFile("a.txt", "from A\n", "task a"),
      b: commitFile("b.txt", "from B\n", "task b"),
    });
    await new Orchestrator({ repoRoot: repo, runner, concurrency: 2 }).run([
      { id: "a", branch: "feat/a", description: "A", targetBranch: "release/1" },
      { id: "b", branch: "feat/b", description: "B", targetBranch: "release/1" },
    ]);

    const git = new Git(repo);
    const mainBefore = await git.revParse("main");
    assert.equal(await git.branchExists("release/1"), false); // created lazily on integrate

    // Land the fleet on a brand-new branch, forked off main.
    const result = await new Integrator({
      repoRoot: repo,
      mainBranch: "release/1",
      baseBranch: "main",
    }).integrate(["feat/a", "feat/b"]);

    assert.equal(result.promoted, true);
    assert.equal(await git.branchExists("release/1"), true);
    // The work is on the target...
    assert.equal(await git.run(["show", "release/1:a.txt"]), "from A");
    assert.equal(await git.run(["show", "release/1:b.txt"]), "from B");
    // ...and main was left exactly where it was.
    assert.equal(await git.revParse("main"), mainBefore);

    // The registry recorded the target for each task.
    const { Registry } = await import("../src/registry.js");
    const reg = await Registry.open(path.join(repo, ".harness", "registry.json"));
    assert.equal(reg.get("feat/a")?.targetBranch, "release/1");
    assert.equal(reg.get("feat/b")?.targetBranch, "release/1");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("re-integrating an already-landed branch is skipped, not aborted", async () => {
  // Regression: a second integrate pass that still lists an already-merged branch
  // must skip it (no-op) and still land the genuinely-new branch — previously the
  // stale branch produced an empty merge that failed `git commit` and aborted the
  // whole train, stranding the new work.
  const repo = await initRepo();
  try {
    const runner = new ScriptWorkerRunner({
      a: commitFile("a.txt", "from A\n", "task a"),
      b: commitFile("b.txt", "from B\n", "task b"),
    });
    await new Orchestrator({ repoRoot: repo, runner, concurrency: 2 }).run([
      { id: "a", branch: "feat/a", description: "A" },
      { id: "b", branch: "feat/b", description: "B" },
    ]);

    // First pass: land feat/a only.
    const first = await new Integrator({ repoRoot: repo }).integrate(["feat/a"]);
    assert.equal(first.promoted, true);

    // Second pass still lists feat/a (already in main) alongside the new feat/b.
    const second = await new Integrator({ repoRoot: repo }).integrate(["feat/a", "feat/b"]);
    assert.equal(second.promoted, true);
    assert.equal(second.steps.find((s) => s.branch === "feat/a")?.status, "merged");
    assert.equal(second.steps.find((s) => s.branch === "feat/b")?.status, "merged");

    const git = new Git(repo);
    assert.equal(await git.run(["show", "main:a.txt"]), "from A");
    assert.equal(await git.run(["show", "main:b.txt"]), "from B"); // the new work landed
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("conflicting branches halt the train and leave main untouched", async () => {
  const repo = await initRepo();
  try {
    // Both branches create config.txt with different contents -> textual conflict.
    const runner = new ScriptWorkerRunner({
      a: commitFile("config.txt", "value = A\n", "set A"),
      b: commitFile("config.txt", "value = B\n", "set B"),
    });
    await new Orchestrator({ repoRoot: repo, runner, concurrency: 2 }).run([
      { id: "a", branch: "feat/a", description: "A" },
      { id: "b", branch: "feat/b", description: "B" },
    ]);

    const git = new Git(repo);
    const mainBefore = await git.revParse("main");

    const integ = new Integrator({ repoRoot: repo });
    const result = await integ.integrate(["feat/a", "feat/b"]);

    assert.equal(result.promoted, false);
    // first merges clean, second conflicts
    assert.equal(result.steps[0]?.status, "merged");
    assert.equal(result.steps[1]?.status, "conflict");
    assert.deepEqual(result.steps[1]?.conflictedFiles, ["config.txt"]);

    // main unchanged
    assert.equal(await git.revParse("main"), mainBefore);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("MergeTool.detectConflicts predicts conflicts without a worktree", async () => {
  const repo = await initRepo();
  try {
    const runner = new ScriptWorkerRunner({
      a: commitFile("shared.txt", "A\n", "A"),
      b: commitFile("shared.txt", "B\n", "B"),
      c: commitFile("other.txt", "C\n", "C"),
    });
    await new Orchestrator({ repoRoot: repo, runner, concurrency: 3 }).run([
      { id: "a", branch: "feat/a", description: "A" },
      { id: "b", branch: "feat/b", description: "B" },
      { id: "c", branch: "feat/c", description: "C" },
    ]);

    const mt = new MergeTool(new Git(repo));
    const conflict = await mt.detectConflicts("feat/a", "feat/b");
    assert.equal(conflict.clean, false);
    assert.deepEqual(conflict.conflictedFiles, ["shared.txt"]);

    const clean = await mt.detectConflicts("feat/a", "feat/c");
    assert.equal(clean.clean, true);
    assert.deepEqual(clean.conflictedFiles, []);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
