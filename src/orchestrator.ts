import path from "node:path";
import { Git } from "./git.js";
import { WorktreeManager, BranchBusyError } from "./worktree.js";
import { Registry } from "./registry.js";
import { TaskDag } from "./task-dag.js";
import { CheckpointManager } from "./checkpoint.js";
import { HarnessEvents } from "./events.js";
import { InboxManager } from "./inbox.js";
import type { TaskId, TaskSpec, WorkerContext, WorkerRunner } from "./types.js";

export interface OrchestratorOptions {
  repoRoot: string;
  runner: WorkerRunner;
  /** Base ref each task branch is created from. Default: repo HEAD at run start. */
  baseRef?: string;
  /** Max concurrent workers. Default 4. */
  concurrency?: number;
  /** Directory for worktrees. Default <repoRoot>/.harness/worktrees. */
  worktreeDir?: string;
  /** Registry file. Default <repoRoot>/.harness/registry.json. */
  registryFile?: string;
  /** Remove a worktree after its worker finishes (branch retained). Default true. */
  cleanupWorktrees?: boolean;
  /** Directory for worker checkpoints. Default <repoRoot>/.harness/checkpoints. */
  checkpointDir?: string;
  /** Emits task:* events for the live UI. */
  events?: HarnessEvents;
  logger?: (msg: string) => void;
}

export interface TaskOutcome {
  taskId: TaskId;
  branch: string;
  state: "completed" | "failed";
  head?: string;
  error?: string;
}

export interface RunResult {
  outcomes: TaskOutcome[];
  completed: number;
  failed: number;
  /** Tasks that never ran because an upstream dependency failed. */
  skipped: TaskId[];
}

/**
 * Fans tasks out to workers on isolated worktrees, respecting the dependency
 * DAG and a concurrency limit. M1 stops at "each task produces a branch" — there
 * is no integration into main yet (that is M2).
 */
export class Orchestrator {
  private readonly log: (m: string) => void;

  constructor(private readonly opts: OrchestratorOptions) {
    this.log = opts.logger ?? (() => {});
  }

  async run(specs: TaskSpec[]): Promise<RunResult> {
    const dag = new TaskDag(specs);
    const repoRoot = this.opts.repoRoot;
    const baseRef = this.opts.baseRef ?? (await new Git(repoRoot).head());
    const concurrency = Math.max(1, this.opts.concurrency ?? 4);
    const cleanup = this.opts.cleanupWorktrees ?? true;
    const wtm = new WorktreeManager(
      repoRoot,
      this.opts.worktreeDir ?? path.join(repoRoot, ".harness", "worktrees"),
    );
    const registry = await Registry.open(
      this.opts.registryFile ?? path.join(repoRoot, ".harness", "registry.json"),
    );
    const checkpoints = new CheckpointManager(
      this.opts.checkpointDir ?? path.join(repoRoot, ".harness", "checkpoints"),
    );
    const inboxes = new InboxManager(repoRoot);

    const outcomes = new Map<TaskId, TaskOutcome>();
    const active = new Map<TaskId, Promise<TaskId>>();

    const runTask = async (id: TaskId): Promise<void> => {
      const node = dag.get(id);
      let worktree: string | undefined;
      this.opts.events?.emitEvent({ type: "task:start", taskId: id, branch: node.branch });
      try {
        await inboxes.clear(node.branch); // drop stale messages from a prior run
        worktree = node.attachBranch
          ? await wtm.addExisting(node.branch) // continue the existing branch in place
          : await wtm.add(node.branch, baseRef);
        await registry.upsert({ taskId: id, branch: node.branch, worktree, state: "running", priority: node.priority, targetBranch: node.targetBranch });
        const ctx: WorkerContext = {
          taskId: id,
          branch: node.branch,
          description: node.description,
          worktree,
          repoRoot,
          git: new Git(worktree),
        };
        const result = await this.opts.runner.run(ctx);
        if (!result.ok) throw new Error(result.error ?? "worker reported failure");
        const head = result.head ?? (await new Git(worktree).head());
        const checkpoint = await checkpoints.save({
          taskId: id,
          branch: node.branch,
          head,
          description: node.description,
          context: result.context,
        });
        dag.setState(id, "completed");
        outcomes.set(id, { taskId: id, branch: node.branch, state: "completed", head });
        await registry.upsert({
          taskId: id,
          branch: node.branch,
          worktree,
          state: "completed",
          head,
          checkpoint,
          priority: node.priority,
          targetBranch: node.targetBranch,
        });
        this.opts.events?.emitEvent({ type: "task:done", taskId: id, branch: node.branch, head });
        this.log(`✔ ${id} -> ${node.branch} @ ${head.slice(0, 8)}`);
      } catch (err: unknown) {
        // A duplicate/concurrent spawn for a branch another live worker already
        // owns: bow out WITHOUT touching the registry, so we don't overwrite that
        // worker's (possibly completed) entry with a spurious failure.
        if (err instanceof BranchBusyError) {
          dag.setState(id, "completed"); // not our task to run; let the owner finish it
          this.log(`• ${id} (${node.branch}): already owned by a live worker — skipping (no clobber)`);
          worktree = undefined; // don't remove the owner's worktree in finally
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        dag.setState(id, "failed");
        outcomes.set(id, { taskId: id, branch: node.branch, state: "failed", error: msg });
        await registry.upsert({ taskId: id, branch: node.branch, worktree, state: "failed", error: msg, priority: node.priority, targetBranch: node.targetBranch });
        this.opts.events?.emitEvent({ type: "task:fail", taskId: id, branch: node.branch, error: msg });
        this.log(`✘ ${id} (${node.branch}): ${msg}`);
      } finally {
        if (cleanup && worktree) {
          await wtm.remove(node.branch, { force: true }).catch(() => {});
        }
      }
    };

    while (!dag.done()) {
      for (const node of dag.ready()) {
        if (active.size >= concurrency) break;
        if (active.has(node.id)) continue;
        dag.setState(node.id, "running"); // claim it so ready() won't re-pick
        this.log(`▶ ${node.id} (branch ${node.branch})`);
        active.set(node.id, runTask(node.id).then(() => node.id));
      }
      if (active.size === 0) break; // nothing ready, nothing running -> blocked by failures
      const finished = await Promise.race(active.values());
      active.delete(finished);
    }

    // Drain any in-flight cleanup before reporting (keeps worktree state tidy).
    await Promise.allSettled(active.values());

    const skipped = dag.all().filter((n) => n.state === "pending").map((n) => n.id);
    for (const id of skipped) {
      const n = dag.get(id);
      outcomes.set(id, {
        taskId: id,
        branch: n.branch,
        state: "failed",
        error: "skipped: upstream dependency failed",
      });
    }

    const list = [...outcomes.values()];
    return {
      outcomes: list,
      completed: list.filter((o) => o.state === "completed").length,
      failed: list.filter((o) => o.state === "failed").length,
      skipped,
    };
  }
}
