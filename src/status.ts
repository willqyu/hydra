import { readFile } from "node:fs/promises";
import path from "node:path";
import { Registry, type RegistryEntry } from "./registry.js";
import { WorktreeManager, type WorktreeInfo } from "./worktree.js";
import { CheckpointManager, type Checkpoint } from "./checkpoint.js";
import { InboxManager } from "./inbox.js";
import { latestActivityAt } from "./transcript.js";
import { Git } from "./git.js";
import type { IntegrationResult } from "./integrator.js";

export interface IntegrationState extends IntegrationResult {
  updatedAt: string;
}

/** A worker record plus its last activity and whether its branch is in main. */
export type WorkerStatus = RegistryEntry & { lastActivityAt?: string; merged?: boolean };

export interface FleetStatus {
  repoRoot: string;
  generatedAt: string;
  /** Per-branch worker records (pending/running/completed/failed). */
  workers: WorkerStatus[];
  /** Live git worktrees (including main). */
  worktrees: WorktreeInfo[];
  /** Durable worker checkpoints. */
  checkpoints: Checkpoint[];
  /** Latest integration result, if any. */
  integration: IntegrationState | null;
  /** Per-branch interaction state (paused + queued message count). */
  inbox: Record<string, { paused: boolean; count: number }>;
  /** Primary working tree (repo root): current branch, the trunk to return to,
   *  and uncommitted-change count. */
  repo: { branch: string; mainBranch: string; dirty: boolean; changes: number };
}

export interface FleetStatusPaths {
  registryFile?: string;
  worktreeDir?: string;
  checkpointDir?: string;
  integrationFile?: string;
}

/** main, else master, else whatever's checked out — the integration trunk. */
async function resolveTrunk(git: Git): Promise<string> {
  if ((await git.tryRun(["rev-parse", "--verify", "--quiet", "main"])).code === 0) return "main";
  if ((await git.tryRun(["rev-parse", "--verify", "--quiet", "master"])).code === 0) return "master";
  return (await git.tryRun(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim() || "HEAD";
}

/**
 * Repair orphaned `running` registry entries. A live worker always holds its
 * worktree — the orchestrator creates the worktree BEFORE marking the entry
 * `running`, and removes it only AFTER marking it terminal — so a `running` entry
 * with no live worktree means the managing process died mid-run and froze the
 * entry (the cause of a finished branch never flagging as ready). We resolve it
 * from git: commits ahead of the trunk => `completed` (the work survived);
 * otherwise => `failed`. Returns the branches that were repaired.
 */
export async function reconcileOrphanedWorkers(
  repoRoot: string,
  paths: FleetStatusPaths = {},
): Promise<string[]> {
  const dir = path.join(repoRoot, ".hydra");
  const registry = await Registry.open(paths.registryFile ?? path.join(dir, "registry.json"));
  const running = registry.all().filter((e) => e.state === "running");
  if (running.length === 0) return [];

  const wtm = new WorktreeManager(repoRoot, paths.worktreeDir ?? path.join(dir, "worktrees"));
  const liveWorktrees = new Set(
    (await wtm.list().catch(() => []))
      .map((w) => w.branch)
      .filter((b): b is string => !!b),
  );
  const git = new Git(repoRoot);
  const trunk = await resolveTrunk(git);

  const repaired: string[] = [];
  for (const e of running) {
    if (liveWorktrees.has(e.branch)) continue; // genuinely running — still holds its worktree
    const head = (await git.tryRun(["rev-parse", "--verify", "--quiet", e.branch])).stdout.trim();
    const ahead = head
      ? (await git.tryRun(["rev-list", "--count", `${trunk}..${e.branch}`])).stdout.trim()
      : "0";
    const { updatedAt: _drop, ...rest } = e;
    if (head && ahead !== "0") {
      await registry.upsert({ ...rest, state: "completed", head });
    } else {
      await registry.upsert({ ...rest, state: "failed", error: "worker ended without completing (orphaned process)" });
    }
    repaired.push(e.branch);
  }
  return repaired;
}

/**
 * Aggregates everything the orchestrator persisted under .hydra into a single
 * snapshot — the read model behind both `hydra status` and the web UI.
 */
export async function readFleetStatus(repoRoot: string, paths: FleetStatusPaths = {}): Promise<FleetStatus> {
  const dir = path.join(repoRoot, ".hydra");
  // Self-heal frozen `running` entries from crashed runs before reading.
  await reconcileOrphanedWorkers(repoRoot, paths).catch(() => {});
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

  const inboxes = new InboxManager(repoRoot);
  const git = new Git(repoRoot);
  const currentBranch = (await git.tryRun(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim() || "HEAD";
  // Resolve the integration trunk: main, else master, else whatever's checked out.
  const mainBranch = (await git.tryRun(["rev-parse", "--verify", "--quiet", "main"])).code === 0
    ? "main"
    : (await git.tryRun(["rev-parse", "--verify", "--quiet", "master"])).code === 0
      ? "master"
      : currentBranch;
  const inbox: Record<string, { paused: boolean; count: number }> = {};
  const workers: WorkerStatus[] = [];
  for (const w of registry.all()) {
    const s = await inboxes.state(w.branch);
    if (s.count > 0) inbox[w.branch] = s;
    // Only running agents are still emitting transcript; skip the stat otherwise.
    const lastActivityAt = w.state === "running" ? await latestActivityAt(repoRoot, w.branch) : null;
    // Whether this branch's work has already landed — in its integration TARGET
    // branch (a session may aim at a non-main branch) OR the trunk. Checking only
    // the trunk left non-main integrations looking un-merged, so their hydra heads
    // never despawned and the "ready to integrate" prompt never cleared. A target
    // that doesn't exist yet simply fails the ancestor check (still un-merged).
    const landingRefs = w.targetBranch && w.targetBranch !== mainBranch
      ? [w.targetBranch, mainBranch]
      : [mainBranch];
    let merged = false;
    if (w.head) {
      for (const ref of landingRefs) {
        if ((await git.tryRun(["merge-base", "--is-ancestor", w.head, ref])).code === 0) { merged = true; break; }
      }
    }
    workers.push({ ...w, ...(lastActivityAt ? { lastActivityAt } : {}), merged });
  }

  // Primary working tree state — drives the checkout buttons.
  const porcelain = (await git.tryRun(["status", "--porcelain"])).stdout;
  const changes = porcelain.split("\n").filter((l) => l.trim()).length;

  return {
    repoRoot,
    generatedAt: new Date().toISOString(),
    workers,
    worktrees: await wtm.list().catch(() => []),
    checkpoints: await cpm.list(),
    integration,
    inbox,
    repo: { branch: currentBranch, mainBranch, dirty: changes > 0, changes },
  };
}
