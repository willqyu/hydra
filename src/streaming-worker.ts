import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { defaultClaudeBin, shouldUseShell } from "./claude.js";
import { InboxManager } from "./inbox.js";
import { HydraEvents } from "./events.js";
import { WorktreeMonitor, sanityCheckResult } from "./worktree-guard.js";
import type { WorkerContext, WorkerResult, WorkerRunner } from "./types.js";

export interface StreamingClaudeAgentRunnerOptions {
  bin?: string;
  /**
   * CLI args. Default runs the agent in stream-json mode so it keeps reading
   * user messages from stdin until stdin closes — enabling mid-run injection.
   */
  args?: string[];
  buildPrompt?: (ctx: WorkerContext) => string;
  /** Turn an inbox text message into a stdin line for the agent. Default emits a
   *  Claude stream-json user message. Override to match a different protocol. */
  formatMessage?: (text: string) => string;
  /** Commit any leftover changes when the agent exits. Default true. */
  autoCommit?: boolean;
  /** Inbox poll interval (ms). Default 500. */
  pollMs?: number;
  /** Hard timeout (ms). Default 30 minutes. */
  timeoutMs?: number;
  /**
   * Auto-wrap-up grace (ms). After the agent finishes a turn (emits a stream-json
   * `result`) it sits idle waiting for more stdin — in interactive mode nothing
   * closes that stdin, so the worker would hang until the hard timeout and never
   * report `completed`. Once the agent has been idle this long with nothing queued
   * and not paused, we close stdin so it exits cleanly and the branch flags ready.
   * A human steering it resets the clock. Default 2 minutes; set 0 to disable
   * (the agent then only ends on an explicit `end` or the hard timeout).
   */
  idleGraceMs?: number;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  events?: HydraEvents;
  logger?: (m: string) => void;
}

export const STREAMING_DEFAULT_ARGS = [
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--permission-mode", "acceptEdits",
  "--verbose",
];

const defaultFormat = (text: string): string =>
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";

// Dynamic seed only — the behavioral guidance (commit cadence, no wrap-up, …)
// arrives as the worker's system prompt (config DEFAULT_PROMPTS.worker), so it's
// editable in Settings and lives in exactly one place.
function defaultPrompt(ctx: WorkerContext): string {
  return [
    `You are an interactive worker on git branch "${ctx.branch}".`,
    `Working directory: ${ctx.worktree}`,
    "",
    "Task:",
    ctx.description,
    "",
    "A human may send you further instructions or corrections as you work;",
    "incorporate them and acknowledge briefly.",
  ].join("\n");
}

/**
 * Interactive worker: spawns a long-lived Claude Code agent and keeps its stdin
 * open, forwarding messages from the agent's per-branch inbox as they arrive —
 * so a human can steer ONE agent (a note, a correction) while its siblings keep
 * running. Control messages: `pause` buffers injections, `resume` flushes them,
 * `end` closes stdin to wrap the agent up.
 */
export class StreamingClaudeAgentRunner implements WorkerRunner {
  constructor(private readonly opts: StreamingClaudeAgentRunnerOptions = {}) {}

  async run(ctx: WorkerContext): Promise<WorkerResult> {
    const bin = this.opts.bin ?? defaultClaudeBin();
    const args = this.opts.args ?? STREAMING_DEFAULT_ARGS;
    const format = this.opts.formatMessage ?? defaultFormat;
    const prompt = (this.opts.buildPrompt ?? defaultPrompt)(ctx);
    const events = this.opts.events;
    const log = this.opts.logger ?? (() => {});
    const inbox = new InboxManager(ctx.repoRoot);

    const before = await ctx.git.head();

    // Watch that the agent stays inside its worktree: each Bash tool call in the
    // stream is checked for an escaping `cd`, the periodic timer reports where it's
    // working, and a post-run check catches commits that landed on the primary
    // checkout instead of this branch.
    const monitor = new WorktreeMonitor({
      worktree: ctx.worktree,
      repoRoot: ctx.repoRoot,
      branch: ctx.branch,
      events,
      logger: log,
    });
    await monitor.start();

    const child: ChildProcessWithoutNullStreams = spawn(bin, args, {
      cwd: ctx.worktree,
      shell: shouldUseShell(bin, this.opts.shell),
      env: { ...process.env, ...this.opts.env },
    });

    const idleGraceMs = this.opts.idleGraceMs ?? 2 * 60 * 1000;
    let paused = false;
    let offset = 0;
    let endRequested = false;
    let ending = false;
    // Idle tracking: `sawResult` flips true when the agent emits a turn-completion
    // `result` event (it's now waiting for input); delivering input flips it back.
    let sawResult = false;
    let lastOutputAt = Date.now();
    const queued: string[] = [];

    let stdout = "";
    let stderr = "";
    let lineBuf = "";
    child.stdout.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      lastOutputAt = Date.now();
      // Detect end-of-turn (stream-json `result`) line by line — that's when the
      // agent goes idle and the idle-grace clock starts.
      lineBuf += s;
      let nl: number;
      while ((nl = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (!line) continue;
        monitor.observeStreamLine(line); // flag any tool call run outside the worktree
        try {
          if ((JSON.parse(line) as { type?: string }).type === "result") sawResult = true;
        } catch {
          /* not a JSON line (e.g. partial or plain log) — ignore */
        }
      }
    });
    child.stderr.on("data", (d) => (stderr += d.toString()));

    // Seed the agent with the task brief.
    child.stdin.write(format(prompt));

    const closeStdin = (): void => {
      if (ending) return;
      ending = true;
      if (child.stdin.writable) child.stdin.end();
    };

    const deliver = (text: string): void => {
      child.stdin.write(format(text));
      sawResult = false; // a fresh turn begins — wait for its result before idle-ending
      lastOutputAt = Date.now();
      events?.emitEvent({ type: "agent:inject", branch: ctx.branch, text });
      log(`→ ${ctx.branch}: injected "${text.slice(0, 60)}"`);
    };

    const poll = async (): Promise<void> => {
      const { messages, offset: next } = await inbox.readFrom(ctx.branch, offset);
      offset = next;
      for (const m of messages) {
        if (m.kind === "pause") {
          paused = true;
          events?.emitEvent({ type: "agent:pause", branch: ctx.branch });
        } else if (m.kind === "resume") {
          paused = false;
          events?.emitEvent({ type: "agent:resume", branch: ctx.branch });
          while (queued.length) deliver(queued.shift()!);
        } else if (m.kind === "inject") {
          const text = m.text ?? "";
          if (paused) queued.push(text);
          else deliver(text);
        } else if (m.kind === "end") {
          endRequested = true;
        }
      }
      if (endRequested) {
        while (queued.length) deliver(queued.shift()!);
        closeStdin();
        return;
      }
      // Auto-wrap-up: the agent finished its turn and has been idle past the grace
      // window with nothing queued and not paused — close stdin so it exits cleanly
      // (otherwise an un-steered/just-steered interactive agent hangs forever).
      if (
        idleGraceMs > 0 && sawResult && !paused && !ending &&
        queued.length === 0 && Date.now() - lastOutputAt > idleGraceMs
      ) {
        log(`↩ ${ctx.branch}: idle ${Math.round((Date.now() - lastOutputAt) / 1000)}s after finishing — wrapping up`);
        closeStdin();
      }
    };

    const timer = setInterval(() => void poll().catch(() => {}), this.opts.pollMs ?? 500);
    const killTimer = setTimeout(() => {
      stderr += "\n[hydra] agent timed out";
      child.kill("SIGKILL");
    }, this.opts.timeoutMs ?? 30 * 60 * 1000);

    const code: number = await new Promise((resolve) => {
      child.on("error", () => resolve(127));
      child.on("close", (c) => resolve(c ?? 0));
    });
    clearInterval(timer);
    clearTimeout(killTimer);
    await poll().catch(() => {}); // final drain for observability
    const { stray, primaryBranch } = await monitor.finalize();

    if (code !== 0) {
      return { ok: false, error: `agent exited ${code}: ${stderr.slice(0, 500)}` };
    }

    if (this.opts.autoCommit ?? true) {
      const dirty = await ctx.git.run(["status", "--porcelain"]);
      if (dirty.trim()) {
        await ctx.git.run(["add", "-A"]);
        await ctx.git.run(["commit", "-m", `${ctx.taskId}: ${firstLine(ctx.description)}`]);
      }
    }

    const head = await ctx.git.head();
    return sanityCheckResult({ branch: ctx.branch, before, head, stray, primaryBranch, context: truncate(stdout) });
  }
}

function firstLine(s: string): string {
  return (s.split("\n")[0] ?? s).slice(0, 72);
}

function truncate(s: string, max = 4000): string {
  return s.length > max ? s.slice(0, max) + "\n…(truncated)" : s;
}
