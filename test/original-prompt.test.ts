import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Git } from "../src/git.js";
import { Orchestrator } from "../src/orchestrator.js";
import { ScriptWorkerRunner, originalRequestLines } from "../src/worker.js";
import type { WorkerContext } from "../src/types.js";

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hydra-op-"));
  const git = new Git(dir);
  await git.run(["init", "-b", "main"]);
  await git.run(["config", "user.email", "test@example.com"]);
  await git.run(["config", "user.name", "Hydra Test"]);
  await writeFile(path.join(dir, "README.md"), "# base\n");
  await git.run(["add", "."]);
  await git.run(["commit", "-m", "init"]);
  return dir;
}

test("the brief carries an 'Original request' section only when it adds information", () => {
  const ctx = (o: Partial<WorkerContext>) => ({ description: "narrow sub-task", ...o }) as WorkerContext;

  // A decomposed sub-task: the overarching prompt differs -> section is present.
  const withOrig = originalRequestLines(ctx({ originalPrompt: "the big overall goal" })).join("\n");
  assert.match(withOrig, /Original request/);
  assert.match(withOrig, /the big overall goal/);
  assert.match(withOrig, /implement ONLY the Task above/); // scope guardrail

  // No original -> nothing added.
  assert.deepEqual(originalRequestLines(ctx({})), []);

  // Original identical to the task (single-worker plan) -> no redundant section.
  assert.deepEqual(originalRequestLines(ctx({ description: "same", originalPrompt: "same" })), []);
});

test("originalPrompt reaches the worker context and is preserved in the checkpoint", async () => {
  const repo = await initRepo();
  try {
    const seen: Record<string, string | undefined> = {};
    const runner = new ScriptWorkerRunner({
      a: async (ctx) => {
        seen[ctx.taskId] = ctx.originalPrompt; // the worker actually receives it
        await writeFile(path.join(ctx.worktree, "a.txt"), "A");
        await ctx.git.run(["add", "."]);
        await ctx.git.run(["commit", "-m", "a"]);
      },
    });
    await new Orchestrator({ repoRoot: repo, runner }).run([
      { id: "a", branch: "feat/a", description: "just the A slice", originalPrompt: "Build the whole widget: A, B and C" },
    ]);

    assert.equal(seen.a, "Build the whole widget: A, B and C", "worker context got the original prompt");

    // And it's durable on the branch's checkpoint record.
    const cp = JSON.parse(await readFile(path.join(repo, ".hydra", "checkpoints", "feat_a.json"), "utf8"));
    assert.equal(cp.originalPrompt, "Build the whole widget: A, B and C");
    assert.equal(cp.description, "just the A slice");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
