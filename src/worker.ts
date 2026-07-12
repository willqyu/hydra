import { runClaude } from "./claude.js";
import { WorktreeMonitor, sanityCheckResult } from "./worktree-guard.js";
import type { HydraEvents } from "./events.js";
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
  /** Fleet event bus — used to surface worktree-containment warnings. */
  events?: HydraEvents;
  logger?: (m: string) => void;
}

/**
 * A brief section that preserves the verbatim original user request the task was
 * derived from, so a decomposed sub-task keeps the overarching goal. Empty when
 * there's no separate original (a hand-written task, or a single-worker plan where
 * the description already IS the request). The scope guardrail matters: without
 * it a worker handed the whole original prompt may try to build all of it.
 */
export function originalRequestLines(ctx: WorkerContext): string[] {
  const orig = ctx.originalPrompt?.trim();
  if (!orig || orig === ctx.description.trim()) return [];
  return [
    "",
    "Original request — the overall user goal this task is one part of. Use it for",
    "context and to resolve ambiguity, but implement ONLY the Task above:",
    orig,
  ];
}

// Dynamic seed only — the behavioral guidance (incremental commits, scope, no
// wrap-up) arrives as the worker's system prompt (config DEFAULT_PROMPTS.worker),
// so it's editable in Settings and lives in exactly one place.
function defaultPrompt(ctx: WorkerContext): string {
  return [
    `You are an autonomous worker on git branch "${ctx.branch}".`,
    `Working directory: ${ctx.worktree}`,
    "",
    "Task:",
    ctx.description,
    ...originalRequestLines(ctx),
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

    // Watch that the agent stays inside its worktree: periodic check-ins on where
    // it's working, plus a post-run check for commits that escaped onto the repo's
    // primary checkout (a headless `-p` run gives no live stream, so the periodic
    // timer reads the agent's transcript on disk).
    const monitor = new WorktreeMonitor({
      worktree: ctx.worktree,
      repoRoot: ctx.repoRoot,
      branch: ctx.branch,
      events: this.opts.events,
      logger: log,
    });
    await monitor.start();

    const proc = await runClaude({
      cwd: ctx.worktree,
      prompt,
      bin: this.opts.bin,
      args: this.opts.args,
      timeoutMs: this.opts.timeoutMs,
      env: this.opts.env,
      shell: this.opts.shell,
    });
    const { stray, primaryBranch } = await monitor.finalize();
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
    return sanityCheckResult({ branch: ctx.branch, before, head, stray, primaryBranch, context: truncate(proc.stdout) });
  }
}

function firstLine(s: string): string {
  return (s.split("\n")[0] ?? s).slice(0, 72);
}

function truncate(s: string, max = 4000): string {
  return s.length > max ? s.slice(0, max) + "\n…(truncated)" : s;
}
