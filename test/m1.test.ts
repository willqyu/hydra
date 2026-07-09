import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Git } from "../src/git.js";
import { Orchestrator } from "../src/orchestrator.js";
import { ScriptWorkerRunner, type WorkerFn } from "../src/worker.js";
import { WorktreeManager } from "../src/worktree.js";

/** Create a throwaway git repo with one commit on `main`. */
async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hydra-m1-"));
  const git = new Git(dir);
  await git.run(["init", "-b", "main"]);
  await git.run(["config", "user.email", "test@example.com"]);
  await git.run(["config", "user.name", "Hydra Test"]);
  await writeFile(path.join(dir, "README.md"), "# base\n");
  await git.run(["add", "."]);
  await git.run(["commit", "-m", "init"]);
  return dir;
}

/** A worker that writes one file and commits it on the task branch. */
function commitFile(file: string, contents: string, message: string): WorkerFn {
  return async (ctx) => {
    await writeFile(path.join(ctx.worktree, file), contents);
    await ctx.git.run(["add", "."]);
    await ctx.git.run(["commit", "-m", message]);
  };
}

test("fans out two independent tasks to separate branches", async () => {
  const repo = await initRepo();
  try {
    const runner = new ScriptWorkerRunner({
      a: commitFile("a.txt", "from A\n", "task a"),
      b: commitFile("b.txt", "from B\n", "task b"),
    });
    const orch = new Orchestrator({ repoRoot: repo, runner, concurrency: 2 });

    const result = await orch.run([
      { id: "a", branch: "feat/a", description: "build A" },
      { id: "b", branch: "feat/b", description: "build B" },
    ]);

    assert.equal(result.completed, 2, "both tasks complete");
    assert.equal(result.failed, 0);

    const git = new Git(repo);
    assert.ok(await git.branchExists("feat/a"));
    assert.ok(await git.branchExists("feat/b"));
    assert.equal(await git.lastSubject("feat/a"), "task a");
    assert.equal(await git.lastSubject("feat/b"), "task b");

    // Worktrees cleaned up: only the main worktree remains.
    const wtm = new WorktreeManager(repo, path.join(repo, ".hydra", "worktrees"));
    const worktrees = await wtm.list();
    assert.equal(worktrees.length, 1, "task worktrees removed, only main remains");

    // Registry recorded both as completed with head commits.
    const reg = JSON.parse(
      await (await import("node:fs/promises")).readFile(
        path.join(repo, ".hydra", "registry.json"),
        "utf8",
      ),
    ) as Array<{ branch: string; state: string; head?: string }>;
    assert.equal(reg.filter((e) => e.state === "completed").length, 2);
    assert.ok(reg.every((e) => typeof e.head === "string" && e.head.length > 0));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("respects the dependency DAG (dependent runs after its blocker)", async () => {
  const repo = await initRepo();
  try {
    const order: string[] = [];
    const record = (id: string): WorkerFn => async (ctx) => {
      order.push(id);
      await writeFile(path.join(ctx.worktree, `${id}.txt`), id);
      await ctx.git.run(["add", "."]);
      await ctx.git.run(["commit", "-m", id]);
    };
    const runner = new ScriptWorkerRunner({ a: record("a"), b: record("b"), c: record("c") });
    const orch = new Orchestrator({ repoRoot: repo, runner, concurrency: 4 });

    const result = await orch.run([
      { id: "a", branch: "feat/a", description: "A" },
      { id: "b", branch: "feat/b", description: "B" },
      { id: "c", branch: "feat/c", description: "C", blockedBy: ["a", "b"] },
    ]);

    assert.equal(result.completed, 3);
    // c must start only after both a and b finished.
    assert.equal(order.indexOf("c"), 2, "c ran last");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("skips tasks whose dependency failed", async () => {
  const repo = await initRepo();
  try {
    const runner = new ScriptWorkerRunner({
      a: async () => {
        throw new Error("boom");
      },
      b: commitFile("b.txt", "B\n", "task b"),
    });
    const orch = new Orchestrator({ repoRoot: repo, runner, concurrency: 2 });

    const result = await orch.run([
      { id: "a", branch: "feat/a", description: "A (fails)" },
      { id: "b", branch: "feat/b", description: "B", blockedBy: ["a"] },
    ]);

    assert.equal(result.failed, 2, "a failed, b skipped");
    assert.deepEqual(result.skipped, ["b"]);
    const aOutcome = result.outcomes.find((o) => o.taskId === "a");
    assert.equal(aOutcome?.state, "failed");
    assert.match(aOutcome?.error ?? "", /boom/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("rejects an invalid DAG (cycle)", async () => {
  const repo = await initRepo();
  try {
    const orch = new Orchestrator({ repoRoot: repo, runner: new ScriptWorkerRunner({}) });
    await assert.rejects(
      orch.run([
        { id: "a", branch: "feat/a", description: "A", blockedBy: ["b"] },
        { id: "b", branch: "feat/b", description: "B", blockedBy: ["a"] },
      ]),
      /cycle/,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
