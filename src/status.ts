import { readFile } from "node:fs/promises";
import path from "node:path";
import { Registry, type RegistryEntry } from "./registry.js";
import { WorktreeManager, type WorktreeInfo } from "./worktree.js";
import { CheckpointManager, type Checkpoint } from "./checkpoint.js";
import { InboxManager } from "./inbox.js";
import type { IntegrationResult } from "./integrator.js";

export interface IntegrationState extends IntegrationResult {
  updatedAt: string;
}

export interface FleetStatus {
  repoRoot: string;
  generatedAt: string;
  /** Per-branch worker records (pending/running/completed/failed). */
  workers: RegistryEntry[];
  /** Live git worktrees (including main). */
  worktrees: WorktreeInfo[];
  /** Durable worker checkpoints. */
  checkpoints: Checkpoint[];
  /** Latest integration result, if any. */
  integration: IntegrationState | null;
  /** Per-branch interaction state (paused + queued message count). */
  inbox: Record<string, { paused: boolean; count: number }>;
}

export interface FleetStatusPaths {
  registryFile?: string;
  worktreeDir?: string;
  checkpointDir?: string;
  integrationFile?: string;
}

/**
 * Aggregates everything the orchestrator persisted under .harness into a single
 * snapshot — the read model behind both `harness status` and the web UI.
 */
export async function readFleetStatus(repoRoot: string, paths: FleetStatusPaths = {}): Promise<FleetStatus> {
  const dir = path.join(repoRoot, ".harness");
  const registry = await Registry.open(paths.registryFile ?? path.join(dir, "registry.json"));
  const wtm = new WorktreeManager(repoRoot, paths.worktreeDir ?? path.join(dir, "worktrees"));
  const cpm = new CheckpointManager(paths.checkpointDir ?? path.join(dir, "checkpoints"));

  let integration: IntegrationState | null = null;
  try {
    integration = JSON.parse(
      await readFile(paths.integrationFile ?? path.join(dir, "integration.json"), "utf8"),
    ) as IntegrationState;
  } catch {
    integration = null;
  }

  const workers = registry.all();
  const inboxes = new InboxManager(repoRoot);
  const inbox: Record<string, { paused: boolean; count: number }> = {};
  for (const w of workers) {
    const s = await inboxes.state(w.branch);
    if (s.count > 0) inbox[w.branch] = s;
  }

  return {
    repoRoot,
    generatedAt: new Date().toISOString(),
    workers,
    worktrees: await wtm.list().catch(() => []),
    checkpoints: await cpm.list(),
    integration,
    inbox,
  };
}
