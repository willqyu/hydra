import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Registry } from "../src/registry.js";

test("a long-lived reader does not revert a concurrent write to a branch it never touched", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-reg-"));
  const file = path.join(dir, "registry.json");
  try {
    // Seed: branch X is "failed".
    const seed = await Registry.open(file);
    await seed.upsert({ taskId: "x", branch: "feat/x", state: "failed", error: "boom" });

    // A long-lived reader (like the dashboard's status poll) opens and holds the
    // stale snapshot where X is failed.
    const reader = await Registry.open(file);

    // Meanwhile another writer repairs X to completed.
    const repair = await Registry.open(file);
    await repair.upsert({ taskId: "x", branch: "feat/x", state: "completed", head: "abc123" });

    // The reader now writes something about a DIFFERENT branch Y. Its flush must
    // not drag X back to failed.
    await reader.upsert({ taskId: "y", branch: "feat/y", state: "running" });

    const final = await Registry.open(file);
    assert.equal(final.get("feat/x")?.state, "completed", "repair to X survived the reader's flush");
    assert.equal(final.get("feat/x")?.head, "abc123");
    assert.equal(final.get("feat/y")?.state, "running", "reader's own write landed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("remove tombstones a branch even against a stale concurrent reader", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-reg-"));
  const file = path.join(dir, "registry.json");
  try {
    const seed = await Registry.open(file);
    await seed.upsert({ taskId: "a", branch: "feat/a", state: "completed" });
    await seed.upsert({ taskId: "b", branch: "feat/b", state: "completed" });

    const remover = await Registry.open(file);
    await remover.remove("feat/a");

    const final = await Registry.open(file);
    assert.equal(final.get("feat/a"), undefined, "removed branch stays gone");
    assert.equal(final.get("feat/b")?.state, "completed", "untouched branch preserved");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
