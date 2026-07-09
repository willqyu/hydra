import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Git } from "../src/git.js";
import { Orchestrator } from "../src/orchestrator.js";
import { ScriptWorkerRunner, type WorkerFn } from "../src/worker.js";
import { Integrator } from "../src/integrator.js";
import { Negotiator } from "../src/negotiator.js";
import { ClaudeConflictResolver } from "../src/claude-resolver.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeResolver = path.join(here, "fixtures", "fake-resolver.mjs");

test("ClaudeConflictResolver runs an agent in the worktree to resolve a conflict", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "hydra-cres-"));
  try {
    const git = new Git(repo);
    await git.run(["init", "-b", "main"]);
    await git.run(["config", "user.email", "test@example.com"]);
    await git.run(["config", "user.name", "Hydra Test"]);
    await writeFile(path.join(repo, "config.txt"), "value = base\n");
    await git.run(["add", "."]);
    await git.run(["commit", "-m", "init"]);

    const edit = (v: string): WorkerFn => async (ctx) => {
      await writeFile(path.join(ctx.worktree, "config.txt"), `value = ${v}\n`);
      await ctx.git.run(["commit", "-am", `set ${v}`]);
    };
    await new Orchestrator({
      repoRoot: repo,
      runner: new ScriptWorkerRunner({ a: edit("A"), b: edit("B") }),
      concurrency: 2,
    }).run([
      { id: "a", branch: "feat/a", description: "A" },
      { id: "b", branch: "feat/b", description: "B" },
    ]);

    // Resolver backed by the fake agent (node + fixture instead of real claude).
    const resolver = new ClaudeConflictResolver({
      name: "fake-claude",
      bin: process.execPath,
      args: [fakeResolver],
    });
    const negotiator = new Negotiator({ resolvers: [resolver], maxRounds: 2 });
    const result = await new Integrator({ repoRoot: repo, negotiator }).integrate(["feat/a", "feat/b"]);

    assert.equal(result.promoted, true);
    assert.equal(result.steps[1]?.status, "resolved");
    assert.equal(await git.run(["show", "main:config.txt"]), "value = resolved-by-agent");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
