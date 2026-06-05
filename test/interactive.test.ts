import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Git } from "../src/git.js";
import { WorktreeManager } from "../src/worktree.js";
import { InboxManager } from "../src/inbox.js";
import { StreamingClaudeAgentRunner } from "../src/streaming-worker.js";
import { HarnessEvents, type HarnessEvent } from "../src/events.js";
import type { WorkerContext } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeAgent = path.join(here, "fixtures", "fake-streaming-agent.mjs");
// Simple {text} framing so the fake agent need not know Claude's stream-json schema.
const textFraming = (text: string) => JSON.stringify({ text }) + "\n";

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-int-"));
  const git = new Git(dir);
  await git.run(["init", "-b", "main"]);
  await git.run(["config", "user.email", "test@example.com"]);
  await git.run(["config", "user.name", "Harness Test"]);
  await writeFile(path.join(dir, "README.md"), "# base\n");
  await git.run(["add", "."]);
  await git.run(["commit", "-m", "init"]);
  return dir;
}

/** Build a worktree + WorkerContext for `branch`, as the orchestrator would. */
async function makeContext(repo: string, branch: string): Promise<WorkerContext> {
  const wtm = new WorktreeManager(repo, path.join(repo, ".harness", "worktrees"));
  const head = await new Git(repo).head();
  const worktree = await wtm.add(branch, head);
  return { taskId: branch, branch, description: "interactive task", worktree, repoRoot: repo, git: new Git(worktree) };
}

test("an injected message is delivered to a running agent and committed", async () => {
  const repo = await initRepo();
  try {
    const ctx = await makeContext(repo, "feat/live");
    const inbox = new InboxManager(repo);
    // Queue a human message + an end signal; the runner forwards both to stdin.
    await inbox.post("feat/live", { kind: "inject", text: "ping-from-human" });
    await inbox.post("feat/live", { kind: "end" });

    const runner = new StreamingClaudeAgentRunner({
      bin: process.execPath,
      args: [fakeAgent],
      formatMessage: textFraming,
      pollMs: 25,
    });
    const result = await runner.run(ctx);
    assert.equal(result.ok, true);

    // The agent committed each message it received; the injected one must be present.
    const log = await ctx.git.run(["log", "--format=%s"]);
    assert.match(log, /agent msg/);
    // Find the committed file containing the injected text.
    const files = await ctx.git.run(["show", "--stat", "HEAD"]); // sanity: there are commits
    assert.ok(files.length > 0);
    const grep = await ctx.git.tryRun(["grep", "-l", "ping-from-human", "HEAD"]);
    assert.equal(grep.code, 0, "injected text was committed by the agent");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("pause buffers injections until resume (delivery order honored)", async () => {
  const repo = await initRepo();
  try {
    const ctx = await makeContext(repo, "feat/pause");
    const inbox = new InboxManager(repo);
    // pause -> inject (should be held) -> resume (flush) -> end
    await inbox.post("feat/pause", { kind: "pause" });
    await inbox.post("feat/pause", { kind: "inject", text: "held-msg" });
    await inbox.post("feat/pause", { kind: "resume" });
    await inbox.post("feat/pause", { kind: "end" });

    const events: HarnessEvent[] = [];
    const ev = new HarnessEvents();
    ev.onEvent((e) => events.push(e));

    const runner = new StreamingClaudeAgentRunner({
      bin: process.execPath,
      args: [fakeAgent],
      formatMessage: textFraming,
      pollMs: 25,
      events: ev,
    });
    const result = await runner.run(ctx);
    assert.equal(result.ok, true);

    const types = events.map((e) => e.type);
    const pauseAt = types.indexOf("agent:pause");
    const resumeAt = types.indexOf("agent:resume");
    const injectAt = types.indexOf("agent:inject");
    assert.ok(pauseAt >= 0 && resumeAt >= 0 && injectAt >= 0, "all interaction events emitted");
    assert.ok(injectAt > resumeAt, "injection delivered only AFTER resume (it was buffered during pause)");
    assert.ok(resumeAt > pauseAt);

    // And the held message still landed.
    const grep = await ctx.git.tryRun(["grep", "-l", "held-msg", "HEAD"]);
    assert.equal(grep.code, 0);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
