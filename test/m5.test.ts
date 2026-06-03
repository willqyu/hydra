import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Git } from "../src/git.js";
import { Orchestrator } from "../src/orchestrator.js";
import { ScriptWorkerRunner, type WorkerFn } from "../src/worker.js";
import { Integrator } from "../src/integrator.js";
import { Negotiator } from "../src/negotiator.js";
import { ScriptConflictResolver } from "../src/resolver.js";
import { HarnessEvents, type HarnessEvent } from "../src/events.js";

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-m5-"));
  const git = new Git(dir);
  await git.run(["init", "-b", "main"]);
  await git.run(["config", "user.email", "test@example.com"]);
  await git.run(["config", "user.name", "Harness Test"]);
  await writeFile(path.join(dir, "config.txt"), "value = base\n");
  await git.run(["add", "."]);
  await git.run(["commit", "-m", "init"]);
  return dir;
}

const editConfig = (value: string): WorkerFn => async (ctx) => {
  await writeFile(path.join(ctx.worktree, "config.txt"), `value = ${value}\n`);
  await ctx.git.run(["commit", "-am", `set ${value}`]);
};

async function makeConflict(repo: string): Promise<void> {
  await new Orchestrator({
    repoRoot: repo,
    runner: new ScriptWorkerRunner({ a: editConfig("A"), b: editConfig("B") }),
    concurrency: 2,
  }).run([
    { id: "a", branch: "feat/a", description: "A" },
    { id: "b", branch: "feat/b", description: "B" },
  ]);
}

test("an unresolvable conflict escalates after bounded rounds instead of looping", async () => {
  const repo = await initRepo();
  try {
    await makeConflict(repo);

    let proposeCalls = 0;
    const escalations: Array<{ branch: string; kind: string }> = [];
    // Resolver that never clears the conflict markers.
    const stubborn = new ScriptConflictResolver("stubborn", () => {
      proposeCalls++;
      return { files: [{ path: "config.txt", content: "<<<<<<< still broken\n" }] };
    });
    const negotiator = new Negotiator({
      resolvers: [stubborn],
      maxRounds: 3,
      onEscalate: (info) => escalations.push({ branch: info.branch, kind: info.kind }),
    });

    const git = new Git(repo);
    const mainBefore = await git.revParse("main");
    const result = await new Integrator({ repoRoot: repo, negotiator }).integrate(["feat/a", "feat/b"]);

    assert.equal(result.promoted, false);
    assert.equal(result.steps[1]?.status, "escalated");
    assert.equal(proposeCalls, 3, "exactly maxRounds attempts — bounded, not infinite");
    assert.deepEqual(escalations, [{ branch: "feat/b", kind: "textual" }]);
    assert.equal(await git.revParse("main"), mainBefore, "main untouched on escalation");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("the orchestrator tie-breaker resolves after the rounds are exhausted", async () => {
  const repo = await initRepo();
  try {
    await makeConflict(repo);

    const stubborn = new ScriptConflictResolver("stubborn", () => ({
      files: [{ path: "config.txt", content: "<<<<<<< still broken\n" }],
    }));
    // Main Agent's final judgement.
    const tieBreaker = new ScriptConflictResolver("main-agent", () => ({
      files: [{ path: "config.txt", content: "value = decided-by-main\n" }],
      note: "final judgement: main agent picks the canonical value",
    }));
    const negotiator = new Negotiator({ resolvers: [stubborn], tieBreaker, maxRounds: 2 });

    const result = await new Integrator({ repoRoot: repo, negotiator }).integrate(["feat/a", "feat/b"]);

    assert.equal(result.promoted, true);
    assert.equal(result.steps[1]?.status, "resolved");
    assert.match(result.steps[1]?.detail ?? "", /tie-break by main-agent/);
    assert.equal(await new Git(repo).run(["show", "main:config.txt"]), "value = decided-by-main");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("events stream the whole run and integration state is persisted", async () => {
  const repo = await initRepo();
  try {
    const events: HarnessEvent[] = [];
    const bus = new HarnessEvents();
    bus.onEvent((e) => events.push(e));

    await new Orchestrator({
      repoRoot: repo,
      runner: new ScriptWorkerRunner({ a: editConfig("A") }),
      concurrency: 1,
      events: bus,
    }).run([{ id: "a", branch: "feat/a", description: "A" }]);

    const result = await new Integrator({ repoRoot: repo, events: bus }).integrate(["feat/a"]);
    assert.equal(result.promoted, true);

    const types = events.map((e) => e.type);
    assert.ok(types.includes("task:start"));
    assert.ok(types.includes("task:done"));
    assert.ok(types.includes("integrate:start"));
    assert.ok(types.includes("integrate:done"));

    // State persisted for the UI to poll.
    const state = JSON.parse(await readFile(path.join(repo, ".harness", "integration.json"), "utf8"));
    assert.equal(state.promoted, true);
    assert.ok(typeof state.updatedAt === "string");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
