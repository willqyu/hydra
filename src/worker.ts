import type { WorkerContext, WorkerResult, WorkerRunner } from "./types.js";

export type WorkerFn = (ctx: WorkerContext) => Promise<void> | void;

/**
 * Runs a JS function as the worker body. The function does its work inside
 * `ctx.worktree` and commits on the task branch; this runner reports the
 * resulting HEAD. Used by tests and for embedding custom logic.
 *
 * Accepts either a single function (applied to every task) or a per-task-id map.
 */
export class ScriptWorkerRunner implements WorkerRunner {
  constructor(private readonly fn: WorkerFn | Record<string, WorkerFn>) {}

  async run(ctx: WorkerContext): Promise<WorkerResult> {
    const fn = typeof this.fn === "function" ? this.fn : this.fn[ctx.taskId];
    if (!fn) return { ok: false, error: `no worker function for task ${ctx.taskId}` };
    try {
      await fn(ctx);
      return { ok: true, head: await ctx.git.head() };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * Placeholder for the real Claude Code agent runner. In the full system this
 * spawns a CC agent (Agent isolation:'worktree' or the `claude` CLI) inside
 * `ctx.worktree`, seeded with `ctx.description`, and waits for it to finish the
 * branch. Wired in a later milestone — M1 validates the orchestration loop with
 * {@link ScriptWorkerRunner}.
 */
export class ClaudeAgentRunner implements WorkerRunner {
  async run(_ctx: WorkerContext): Promise<WorkerResult> {
    return { ok: false, error: "ClaudeAgentRunner not implemented yet (M1 uses ScriptWorkerRunner)" };
  }
}
