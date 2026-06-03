import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Git } from "../src/git.js";
import { Orchestrator } from "../src/orchestrator.js";
import { ScriptWorkerRunner, type WorkerFn } from "../src/worker.js";
import { Integrator } from "../src/integrator.js";
import { Negotiator } from "../src/negotiator.js";
import { ScriptConflictResolver } from "../src/resolver.js";
import { CheckpointManager } from "../src/checkpoint.js";

async function write(dir: string, file: string, content: string): Promise<void> {
  await writeFile(path.join(dir, file), content);
}

/** Base repo: lib.greet() consumed by app.js; check.js is the test gate. */
async function initSemanticRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-m4-"));
  const git = new Git(dir);
  await git.run(["init", "-b", "main"]);
  await git.run(["config", "user.email", "test@example.com"]);
  await git.run(["config", "user.name", "Harness Test"]);
  await write(dir, "lib.js", `function greet() { return "hi"; }\nmodule.exports = { greet };\n`);
  await write(dir, "app.js", `const { greet } = require("./lib");\nmodule.exports = function () { return greet() + "!"; };\n`);
  await write(dir, "check.js", `const app = require("./app");\nif (app() !== "hi!") { process.exit(1); }\n`);
  await git.run(["add", "."]);
  await git.run(["commit", "-m", "init"]);
  return dir;
}

test("semantic conflict (clean merge, broken tests) is caught by the gate and fixed", async () => {
  const repo = await initSemanticRepo();
  try {
    // Branch A renames greet -> salute and updates its own caller (self-consistent).
    const a: WorkerFn = async (ctx) => {
      await write(ctx.worktree, "lib.js", `function salute() { return "hi"; }\nmodule.exports = { salute };\n`);
      await write(ctx.worktree, "app.js", `const { salute } = require("./lib");\nmodule.exports = function () { return salute() + "!"; };\n`);
      await ctx.git.run(["commit", "-am", "rename greet -> salute"]);
    };
    // Branch B adds feature.js calling greet (old name) + extends the gate. Touches
    // DIFFERENT files than A, so the merge is textually clean.
    const b: WorkerFn = async (ctx) => {
      await write(ctx.worktree, "feature.js", `const { greet } = require("./lib");\nmodule.exports = function () { return greet().toUpperCase(); };\n`);
      await write(ctx.worktree, "check.js", `const app = require("./app");\nconst feature = require("./feature");\nif (app() !== "hi!") { process.exit(1); }\nif (feature() !== "HI") { process.exit(1); }\n`);
      await ctx.git.run(["add", "."]);
      await ctx.git.run(["commit", "-m", "add feature using greet"]);
    };

    await new Orchestrator({
      repoRoot: repo,
      runner: new ScriptWorkerRunner({ a, b }),
      concurrency: 2,
    }).run([
      { id: "a", branch: "feat/a", description: "rename" },
      { id: "b", branch: "feat/b", description: "feature" },
    ]);

    // Sanity: the merge is textually clean (different files) — git won't flag it.
    const { MergeTool } = await import("../src/merge.js");
    const conflict = await new MergeTool(new Git(repo)).detectConflicts("feat/a", "feat/b");
    assert.equal(conflict.clean, true, "merge is textually clean — only the gate can catch the break");

    // Semantic resolver: point feature.js at the renamed function.
    const resolver = new ScriptConflictResolver("semantic-fixer", () => ({
      files: [
        {
          path: "feature.js",
          content: `const { salute } = require("./lib");\nmodule.exports = function () { return salute().toUpperCase(); };\n`,
        },
      ],
      note: "feature.js now calls salute (renamed from greet)",
    }));
    const negotiator = new Negotiator({ resolvers: [resolver], maxRounds: 3 });

    const result = await new Integrator({
      repoRoot: repo,
      testCommand: "node check.js",
      negotiator,
    }).integrate(["feat/a", "feat/b"]);

    assert.equal(result.promoted, true);
    // feat/b's step was flipped from "merged" to "resolved" by the semantic gate.
    assert.equal(result.steps[1]?.status, "resolved");

    const git = new Git(repo);
    assert.match(await git.run(["show", "main:feature.js"]), /salute/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("an idle worker is checkpointed and rehydrated to resolve a late conflict", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "harness-m4cp-"));
  try {
    const git = new Git(repo);
    await git.run(["init", "-b", "main"]);
    await git.run(["config", "user.email", "test@example.com"]);
    await git.run(["config", "user.name", "Harness Test"]);
    await write(repo, "config.txt", "value = base\n");
    await git.run(["add", "."]);
    await git.run(["commit", "-m", "init"]);

    // Workers hand back distilled context that the orchestrator checkpoints.
    const edit = (value: string): WorkerFn => async (ctx) => {
      await write(ctx.worktree, "config.txt", `value = ${value}\n`);
      await ctx.git.run(["commit", "-am", `set ${value}`]);
      return { context: `final value for ${ctx.branch} is "${value}"` };
    };

    const checkpointDir = path.join(repo, ".harness", "checkpoints");
    await new Orchestrator({
      repoRoot: repo,
      runner: new ScriptWorkerRunner({ a: edit("A"), b: edit("B") }),
      concurrency: 2,
      checkpointDir,
    }).run([
      { id: "a", branch: "feat/a", description: "set A" },
      { id: "b", branch: "feat/b", description: "set B" },
    ]);

    // Workers are despawned (worktrees gone). Their state survives as checkpoints.
    const cpm = new CheckpointManager(checkpointDir);
    assert.equal((await cpm.list()).length, 2);
    const cpB = await cpm.load("feat/b");
    assert.ok(cpB?.context?.includes("feat/b"));

    // Rehydrate feat/b's worker as the resolver, seeded from its checkpoint.
    const rehydrated = await cpm.rehydrate("feat/b", (cp) =>
      new ScriptConflictResolver(`rehydrated:${cp.branch}`, () => ({
        files: [{ path: "config.txt", content: `value = A+B (from checkpoint of ${cp.branch})\n` }],
        note: `rehydrated worker recalled: ${cp.context}`,
      })),
    );

    const negotiator = new Negotiator({ resolvers: [rehydrated], maxRounds: 2 });
    const result = await new Integrator({ repoRoot: repo, negotiator }).integrate(["feat/a", "feat/b"]);

    assert.equal(result.promoted, true);
    assert.equal(result.steps[1]?.status, "resolved");
    assert.match(await git.run(["show", "main:config.txt"]), /from checkpoint of feat\/b/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
