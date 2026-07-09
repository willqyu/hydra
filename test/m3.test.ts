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
import { IntraFleetBus } from "../src/bus.js";

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hydra-m3-"));
  const git = new Git(dir);
  await git.run(["init", "-b", "main"]);
  await git.run(["config", "user.email", "test@example.com"]);
  await git.run(["config", "user.name", "Hydra Test"]);
  await writeFile(path.join(dir, "config.txt"), "value = base\n");
  await git.run(["add", "."]);
  await git.run(["commit", "-m", "init"]);
  return dir;
}

function editConfig(value: string): WorkerFn {
  return async (ctx) => {
    await writeFile(path.join(ctx.worktree, "config.txt"), `value = ${value}\n`);
    await ctx.git.run(["commit", "-am", `set ${value}`]);
  };
}

test("two branches editing the same file are negotiated and landed", async () => {
  const repo = await initRepo();
  try {
    await new Orchestrator({
      repoRoot: repo,
      runner: new ScriptWorkerRunner({ a: editConfig("A"), b: editConfig("B") }),
      concurrency: 2,
    }).run([
      { id: "a", branch: "feat/a", description: "A" },
      { id: "b", branch: "feat/b", description: "B" },
    ]);

    const bus = new IntraFleetBus();
    // Resolver that unions both sides into a deterministic resolved file.
    const resolver = new ScriptConflictResolver("merger", () => ({
      files: [{ path: "config.txt", content: "value = A+B\n" }],
      note: "kept both values as A+B",
    }));
    const negotiator = new Negotiator({ resolvers: [resolver], bus, maxRounds: 3 });

    const integ = new Integrator({ repoRoot: repo, negotiator });
    const result = await integ.integrate(["feat/a", "feat/b"]);

    assert.equal(result.promoted, true);
    assert.deepEqual(result.steps.map((s) => s.status), ["merged", "resolved"]);

    const git = new Git(repo);
    assert.equal(await git.run(["show", "main:config.txt"]), "value = A+B");

    // Negotiation transcript was recorded on the bus.
    const kinds = bus.transcript().map((m) => m.kind);
    assert.ok(kinds.includes("propose"));
    assert.ok(kinds.includes("resolved"));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a resolution that still has conflict markers is rejected, then a later round succeeds", async () => {
  const repo = await initRepo();
  try {
    await new Orchestrator({
      repoRoot: repo,
      runner: new ScriptWorkerRunner({ a: editConfig("A"), b: editConfig("B") }),
      concurrency: 2,
    }).run([
      { id: "a", branch: "feat/a", description: "A" },
      { id: "b", branch: "feat/b", description: "B" },
    ]);

    // Round 1 leaves a marker (rejected); round 2 cleans it up.
    const flaky = new ScriptConflictResolver("flaky", (req) =>
      req.round === 1
        ? { files: [{ path: "config.txt", content: "<<<<<<< still conflicted\n" }] }
        : { files: [{ path: "config.txt", content: "value = reconciled\n" }] },
    );
    const negotiator = new Negotiator({ resolvers: [flaky], maxRounds: 3 });
    const result = await new Integrator({ repoRoot: repo, negotiator }).integrate(["feat/a", "feat/b"]);

    assert.equal(result.promoted, true);
    assert.equal((await new Git(repo).run(["show", "main:config.txt"])), "value = reconciled");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
