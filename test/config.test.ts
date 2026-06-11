import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, saveConfig, sanitizeConfig, roleArgs } from "../src/config.js";

test("sanitizeConfig keeps known roles and rejects flag-like model names", () => {
  const cfg = sanitizeConfig({
    prompts: { worker: "  be terse  ", bogus: "ignored", supervisor: "" },
    models: { worker: "opus", negotiator: "--dangerously-skip-permissions", supervisor: "claude-sonnet-4-6" },
  });
  assert.deepEqual(cfg.prompts, { worker: "be terse" });
  assert.deepEqual(cfg.models, { worker: "opus", supervisor: "claude-sonnet-4-6" });
});

test("roleArgs maps config onto claude CLI flags", () => {
  const cfg = sanitizeConfig({ prompts: { worker: "extra rules" }, models: { worker: "haiku" } });
  assert.deepEqual(roleArgs(cfg, "worker"), ["--model", "haiku", "--append-system-prompt", "extra rules"]);
  assert.deepEqual(roleArgs(cfg, "supervisor"), []);
});

test("saveConfig/loadConfig roundtrip through .harness/config.json", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "harness-config-"));
  try {
    assert.deepEqual(await loadConfig(repo), { prompts: {}, models: {} }); // no file yet
    await saveConfig(repo, { prompts: { negotiator: "prefer ours" }, models: { supervisor: "opus" } });
    const loaded = await loadConfig(repo);
    assert.deepEqual(loaded.prompts, { negotiator: "prefer ours" });
    assert.deepEqual(loaded.models, { supervisor: "opus" });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
