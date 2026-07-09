import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resumeArgs } from "../src/resume.js";
import { listRepoSessions, findSessionFile, stageSessionForCwd } from "../src/transcript.js";

// Mirror of transcript.ts encodeProjectDir — how Claude Code names a cwd's project dir.
const encode = (cwd: string): string => cwd.replace(/[/._]/g, "-");

/** Write a minimal transcript with an opening user message. */
async function seedSession(dir: string, id: string, firstUserText: string, ts = "2026-07-09T00:00:00.000Z") {
  await mkdir(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "user", timestamp: ts, gitBranch: "master", message: { role: "user", content: [{ type: "text", text: firstUserText }] } }),
    JSON.stringify({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
  ];
  await writeFile(path.join(dir, `${id}.jsonl`), lines.join("\n") + "\n");
}

test("resumeArgs builds fork/resume flags and is empty without a session", () => {
  assert.deepEqual(resumeArgs(undefined), []);
  assert.deepEqual(resumeArgs("abc"), ["--resume", "abc", "--fork-session"]);
  assert.deepEqual(resumeArgs("abc", false), ["--resume", "abc"]);
});

test("listRepoSessions returns human chats (not planner sessions), newest first", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hydra-proj-"));
  try {
    const repo = "/tmp/my-repo";
    const repoDir = path.join(root, encode(repo));
    await seedSession(repoDir, "sess-old", "Help me build a CSV exporter", "2026-07-01T00:00:00.000Z");
    await seedSession(repoDir, "sess-new", "Refactor the auth module", "2026-07-08T00:00:00.000Z");
    // A hydra planner session that must be filtered out.
    await seedSession(repoDir, "planner", "Summarize the following task as a git branch name");

    const sessions = await listRepoSessions(repo, root);
    const ids = sessions.map((s) => s.sessionId);
    assert.ok(!ids.includes("planner"), "planner session should be excluded");
    assert.deepEqual(ids, ["sess-new", "sess-old"], "newest-active first");
    assert.equal(sessions[0]!.title, "Refactor the auth module");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stageSessionForCwd copies a repo-root session into the worktree's project dir so --resume can find it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hydra-proj-"));
  try {
    const repo = "/tmp/my-repo";
    const repoDir = path.join(root, encode(repo));
    await seedSession(repoDir, "sess-1", "Original conversation");

    // findSessionFile locates it in the repo-root project dir.
    const found = await findSessionFile(repo, "sess-1", root);
    assert.equal(found, path.join(repoDir, "sess-1.jsonl"));

    // A worker's worktree maps to a different project dir; staging must copy the
    // transcript there so `claude --resume sess-1` resolves from the worktree cwd.
    const worktree = path.join(repo, ".hydra", "worktrees", "feat_x");
    const ok = await stageSessionForCwd(repo, "sess-1", worktree, root);
    assert.equal(ok, true);
    const staged = path.join(root, encode(worktree), "sess-1.jsonl");
    await stat(staged); // throws if missing
    assert.equal(await readFile(staged, "utf8"), await readFile(found!, "utf8"));

    // Missing session id -> false, no throw.
    assert.equal(await stageSessionForCwd(repo, "does-not-exist", worktree, root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
