import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { InboxManager } from "./inbox.js";
import { HarnessEvents } from "./events.js";
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
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  events?: HarnessEvents;
  logger?: (m: string) => void;
}

const DEFAULT_ARGS = [
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--permission-mode", "acceptEdits",
  "--verbose",
];

const defaultFormat = (text: string): string =>
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";

function defaultPrompt(ctx: WorkerContext): string {
  return [
    `You are an interactive worker on git branch "${ctx.branch}".`,
    `Working directory: ${ctx.worktree}`,
    "",
    "Task:",
    ctx.description,
    "",
    "Implement the task in this worktree. Commit your work INCREMENTALLY — after",
    "each logical step run `git add -A && git commit` with a clear message; do not",
    "wait until the end. A human may send you further instructions or corrections",
    "as you work; incorporate them and acknowledge briefly. When the task is fully",
    "done, summarize the key decisions you made.",
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
    const bin = this.opts.bin ?? (process.platform === "win32" ? "claude.cmd" : "claude");
    const args = this.opts.args ?? DEFAULT_ARGS;
    const format = this.opts.formatMessage ?? defaultFormat;
    const prompt = (this.opts.buildPrompt ?? defaultPrompt)(ctx);
    const events = this.opts.events;
    const log = this.opts.logger ?? (() => {});
    const inbox = new InboxManager(ctx.repoRoot);

    const before = await ctx.git.head();
    const child: ChildProcessWithoutNullStreams = spawn(bin, args, {
      cwd: ctx.worktree,
      shell: this.opts.shell ?? false,
      env: { ...process.env, ...this.opts.env },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    // Seed the agent with the task brief.
    child.stdin.write(format(prompt));

    let paused = false;
    let offset = 0;
    let endRequested = false;
    const queued: string[] = [];

    const deliver = (text: string): void => {
      child.stdin.write(format(text));
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
        if (child.stdin.writable) child.stdin.end();
      }
    };

    const timer = setInterval(() => void poll().catch(() => {}), this.opts.pollMs ?? 500);
    const killTimer = setTimeout(() => {
      stderr += "\n[harness] agent timed out";
      child.kill("SIGKILL");
    }, this.opts.timeoutMs ?? 30 * 60 * 1000);

    const code: number = await new Promise((resolve) => {
      child.on("error", () => resolve(127));
      child.on("close", (c) => resolve(c ?? 0));
    });
    clearInterval(timer);
    clearTimeout(killTimer);
    await poll().catch(() => {}); // final drain for observability

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
    if (head === before) return { ok: false, error: "agent produced no commits" };
    return { ok: true, head, context: truncate(stdout) };
  }
}

function firstLine(s: string): string {
  return (s.split("\n")[0] ?? s).slice(0, 72);
}

function truncate(s: string, max = 4000): string {
  return s.length > max ? s.slice(0, max) + "\n…(truncated)" : s;
}
