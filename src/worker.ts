import { runClaude } from "./claude.js";
import type { WorkerContext, WorkerResult, WorkerRunner } from "./types.js";

/** A worker may return distilled context to be saved in its checkpoint. */
export type WorkerFnResult = void | { context?: string };
export type WorkerFn = (ctx: WorkerContext) => Promise<WorkerFnResult> | WorkerFnResult;

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
      const ret = await fn(ctx);
      const context = ret && typeof ret === "object" ? ret.context : undefined;
      return { ok: true, head: await ctx.git.head(), context };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export interface ClaudeAgentRunnerOptions {
  /** The CLI executable. Default "claude.cmd" on Windows, else "claude". */
  bin?: string;
  /**
   * Args passed to the CLI. The prompt is fed on stdin, so `-p` runs headless.
   * Default: ["-p", "--permission-mode", "acceptEdits"]. Use
   * "--dangerously-skip-permissions" for fully autonomous runs.
   */
  args?: string[];
  /** Builds the prompt from the task context. Default: a standard worker brief. */
  buildPrompt?: (ctx: WorkerContext) => string;
  /** Commit any changes the agent left uncommitted. Default true. */
  autoCommit?: boolean;
  /** Kill the agent after this many ms. Default 30 minutes. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Spawn through a shell (needed if `bin` is a shell builtin/alias). Default false. */
  shell?: boolean;
  logger?: (m: string) => void;
}

function defaultPrompt(ctx: WorkerContext): string {
  return [
    `You are an autonomous worker on git branch "${ctx.branch}".`,
    `Working directory: ${ctx.worktree}`,
    "",
    "Task:",
    ctx.description,
    "",
    "Implement the task end to end in this worktree. Commit your work INCREMENTALLY:",
    "after each logical step or working sub-change, run `git add -A && git commit`",
    "with a clear message — do NOT wait until the very end to make a single commit.",
    "Frequent commits keep your progress safe and make integration easier.",
    "Keep the change scoped to this task. When done, briefly state the key decisions",
    "you made (these are saved as your checkpoint context).",
  ].join("\n");
}

/**
 * Real worker: spawns a Claude Code agent headless inside the task's worktree,
 * seeded with the task description, and waits for it to produce commits on the
 * branch. Returns the agent's stdout as checkpoint context. Stdin carries the
 * prompt so no shell-escaping of task text is needed.
 */
export class ClaudeAgentRunner implements WorkerRunner {
  constructor(private readonly opts: ClaudeAgentRunnerOptions = {}) {}

  async run(ctx: WorkerContext): Promise<WorkerResult> {
    const prompt = (this.opts.buildPrompt ?? defaultPrompt)(ctx);
    const log = this.opts.logger ?? (() => {});

    const before = await ctx.git.head();

    const proc = await runClaude({
      cwd: ctx.worktree,
      prompt,
      bin: this.opts.bin,
      args: this.opts.args,
      timeoutMs: this.opts.timeoutMs,
      env: this.opts.env,
      shell: this.opts.shell,
    });
    if (proc.code !== 0) {
      return { ok: false, error: `agent exited ${proc.code}: ${proc.stderr.slice(0, 500)}` };
    }
    log(`agent finished for ${ctx.branch}`);

    if (this.opts.autoCommit ?? true) {
      const dirty = await ctx.git.run(["status", "--porcelain"]);
      if (dirty.trim()) {
        await ctx.git.run(["add", "-A"]);
        await ctx.git.run(["commit", "-m", `${ctx.taskId}: ${firstLine(ctx.description)}`]);
      }
    }

    const head = await ctx.git.head();
    if (head === before) {
      return { ok: false, error: "agent produced no commits" };
    }
    return { ok: true, head, context: truncate(proc.stdout) };
  }
}

function firstLine(s: string): string {
  return (s.split("\n")[0] ?? s).slice(0, 72);
}

function truncate(s: string, max = 4000): string {
  return s.length > max ? s.slice(0, max) + "\n…(truncated)" : s;
}
