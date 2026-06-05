import type { Git } from "./git.js";

export type TaskId = string;

/** A unit of work the orchestrator fans out to a worker on its own branch. */
export interface TaskSpec {
  id: TaskId;
  /** Branch name created for this task's work. Must be unique across the DAG. */
  branch: string;
  /** Human-readable spec handed to the worker. */
  description: string;
  /** Task ids that must complete before this one can start. */
  blockedBy?: TaskId[];
}

export type TaskState = "pending" | "running" | "completed" | "failed";

/** Everything a worker needs to do its job in isolation. */
export interface WorkerContext {
  taskId: TaskId;
  branch: string;
  description: string;
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
