import type { Git } from "./git.js";

export type TaskId = string;

/** A unit of work the orchestrator fans out to a worker on its own branch. */
export interface TaskSpec {
  id: TaskId;
  /** Branch name created for this task's work. Must be unique across the DAG. */
  branch: string;
  /** Human-readable spec handed to the worker. */
  description: string;
  /**
   * The verbatim original user request this task was derived from. When a
   * supervisor decomposes one prompt into a fleet, every task's `description` is a
   * narrowed sub-brief; this keeps the overarching prompt so each worker (and each
   * branch's durable record) preserves what the human actually asked for. Absent
   * for hand-written task specs where the description already IS the request.
   */
  originalPrompt?: string;
  /** Task ids that must complete before this one can start. */
  blockedBy?: TaskId[];
  /**
   * Relative importance for integration tradeoffs: 1 = highest. When a fleet's
   * branches conflict, higher-priority branches land first and an unresolvable
   * lower-priority branch is dropped rather than halting the whole train.
   */
  priority?: number;
  /**
   * Continue an existing branch in place (check it out and stack commits) rather
   * than creating a fresh branch. Used to extend an un-integrated task.
   */
  attachBranch?: boolean;
  /**
   * Branch this task's work should ultimately be integrated INTO — the merge-train's
   * promote target. Distinct from `branch` (this task's own isolated work branch) and
   * from its worktree: the worker still commits to `branch`, but at integration time
   * the fleet lands on `targetBranch` instead of main. Absent = the repo trunk
   * (main/master). All tasks from one spawn session share a target so they land
   * together. May name a branch that doesn't exist yet (created lazily on integrate).
   */
  targetBranch?: string;
}

export type TaskState = "pending" | "running" | "completed" | "failed";

/** Everything a worker needs to do its job in isolation. */
export interface WorkerContext {
  taskId: TaskId;
  branch: string;
  description: string;
  /** The verbatim original user request this task was derived from (see TaskSpec). */
  originalPrompt?: string;
  /** Absolute path to the isolated git worktree for this task. */
  worktree: string;
  /** Repo root — used to locate the per-agent inbox for live interaction. */
  repoRoot: string;
  /** Git helper already scoped to the worktree directory. */
  git: Git;
}

export interface WorkerResult {
  ok: boolean;
  /** HEAD commit sha on the task branch after the worker ran. */
  head?: string;
  /** Distilled context to persist in the worker's checkpoint (decisions, intent). */
  context?: string;
  error?: string;
}

/** Pluggable execution backend for a single task (script, real CC agent, …). */
export interface WorkerRunner {
  run(ctx: WorkerContext): Promise<WorkerResult>;
}
