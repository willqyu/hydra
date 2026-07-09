import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Git } from "../src/git.js";
import { Orchestrator } from "../src/orchestrator.js";
import { ClaudeAgentRunner } from "../src/worker.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// A stand-in for the `claude` CLI: reads the prompt on stdin, writes it to a
// file, prints a one-line summary, and exits 0 — exercising ClaudeAgentRunner's
// spawn/stdin/auto-commit/context path without invoking the real agent.
const fakeAgent = path.join(here, "fixtures", "fake-claude.mjs");

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hydra-agent-"));
  const git = new Git(dir);
  await git.run(["init", "-b", "main"]);
  await git.run(["config", "user.email", "test@example.com"]);
  await git.run(["config", "user.name", "Hydra Test"]);
  await writeFile(path.join(dir, "README.md"), "# base\n");
  await git.run(["add", "."]);
  await git.run(["commit", "-m", "init"]);
  return dir;
}

test("ClaudeAgentRunner spawns the agent, passes the prompt, and commits its work", async () => {
  const repo = await initRepo();
  try {
    const runner = new ClaudeAgentRunner({
      bin: process.execPath, // node
      args: [fakeAgent],
      buildPrompt: (ctx) => `TASK:${ctx.description}`,
    });
    const result = await new Orchestrator({ repoRoot: repo, runner, concurrency: 1 }).run([
      { id: "a", branch: "feat/a", description: "build the thing" },
    ]);

    assert.equal(result.completed, 1);
    const git = new Git(repo);
    // The fake agent wrote the prompt it received into agent-output.txt.
    const output = await git.run(["show", "feat/a:agent-output.txt"]);
    assert.match(output, /TASK:build the thing/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("ClaudeAgentRunner reports failure when the agent makes no commits", async () => {
  const repo = await initRepo();
  try {
    const runner = new ClaudeAgentRunner({
      bin: process.execPath,
      args: [fakeAgent],
      env: { FAKE_AGENT_NOOP: "1" }, // tell the fake to do nothing
    });
    const result = await new Orchestrator({ repoRoot: repo, runner, concurrency: 1 }).run([
      { id: "a", branch: "feat/a", description: "noop" },
    ]);

    assert.equal(result.failed, 1);
    assert.match(result.outcomes[0]?.error ?? "", /no commits/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
