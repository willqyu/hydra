import { readdir, stat, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Git } from "./git.js";
import type { HydraEvents } from "./events.js";

/**
 * Worktree containment guard.
 *
 * A worker agent is spawned with its cwd set to an isolated worktree, but `cwd`
 * is only a starting directory — with an unrestricted shell the agent can `cd`
 * anywhere (e.g. into the repo's primary checkout) and `git commit` there, which
 * silently lands its work on the wrong branch (this is how a task can "succeed"
 * yet the hydra reports "agent produced no commits"). This module:
 *   - watches WHERE the agent is actually working (from its live transcript and,
 *     for streaming runs, its tool-call stream) and flags any step taken outside
 *     the worktree; and
 *   - runs a post-run sanity check that catches commits which landed on the
 *     repo's primary checkout instead of the worker's branch.
 * It only observes and reports — it never rewrites history.
 */

/** A commit that landed on the primary checkout instead of the worker's branch. */
export interface StrayCommit {
  sha: string;
  subject: string;
}

/** Branch + head of the repo's PRIMARY working tree (the checkout at repoRoot, not
 *  a worktree) at the instant a worker starts. An escaping agent that commits from
 *  repoRoot moves THIS ref; comparing against the snapshot is how we catch it. */
export interface PrimarySnapshot {
  branch: string;
  head: string;
}

export async function snapshotPrimary(repoRoot: string): Promise<PrimarySnapshot> {
  const git = new Git(repoRoot);
  const branch = (await git.tryRun(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim() || "HEAD";
  const head = (await git.tryRun(["rev-parse", "HEAD"])).stdout.trim();
  return { branch, head };
}

/** Commits the primary checkout gained since `snap` — i.e. work an escaped agent
 *  committed there instead of on its own branch. Empty when nothing strayed. */
export async function strayCommits(repoRoot: string, snap: PrimarySnapshot): Promise<StrayCommit[]> {
  if (!snap.head) return [];
  const git = new Git(repoRoot);
  const now = (await git.tryRun(["rev-parse", "HEAD"])).stdout.trim();
  if (!now || now === snap.head) return [];
  // Anything reachable from the primary head now but not at snapshot time.
  const r = await git.tryRun(["log", "--format=%H%x1f%s", `${snap.head}..${now}`]);
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [sha, subject] = l.split("\x1f");
      return { sha: sha ?? "", subject: subject ?? "" };
    });
}

/** The effective working directory of a shell command. A leading `cd <dir>` (the
 *  pattern an escaping agent uses — `cd /repo && git commit …`) overrides the spawn
 *  cwd; otherwise the command runs in `cwd`. Returns an absolute path. */
export function bashWorkingDir(command: string, cwd: string): string {
  const m = command.match(/^\s*cd\s+(?:'([^']+)'|"([^"]+)"|([^\s;&|<>]+))/);
  const target = m?.[1] ?? m?.[2] ?? m?.[3];
  if (!target || target === "-") return cwd; // `cd -` / no cd: unknown → assume cwd
  const expanded = target.startsWith("~") ? (os.homedir() + target.slice(1)) : target;
  return path.resolve(cwd, expanded);
}

/** True when `dir` is the worktree itself or nested inside it. */
export function isInsideWorktree(dir: string, worktree: string): boolean {
  const rel = path.relative(worktree, dir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Mirrors Claude Code's per-cwd transcript layout (see transcript.ts): each agent
// streams its session to ~/.claude/projects/<encoded-cwd>/<session>.jsonl.
const PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");
function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/._]/g, "-");
}

async function newestTranscript(dir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  let best: { f: string; m: number } | null = null;
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue;
    try {
      const s = await stat(path.join(dir, f));
      if (!best || s.mtimeMs > best.m) best = { f, m: s.mtimeMs };
    } catch {
      /* skip */
    }
  }
  return best ? path.join(dir, best.f) : null;
}

/** The directory the worker's agent most recently ran a Bash command from, read
 *  from its live transcript. Works for any runner (the transcript is always
 *  written). Null when there's no session yet or no shell command recorded. */
export async function latestAgentDir(worktree: string): Promise<string | null> {
  const file = await newestTranscript(path.join(PROJECTS_ROOT, encodeProjectDir(worktree)));
  if (!file) return null;
  let tail: string;
  try {
    const s = await stat(file);
    const start = Math.max(0, s.size - 64 * 1024); // last 64KB is plenty for the latest tool call
    const fh = await open(file, "r");
    try {
      const len = s.size - start;
      const b = Buffer.alloc(len);
      await fh.read(b, 0, len, start);
      tail = b.toString("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trim();
    if (!line) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // partial first line from the 64KB window, or non-JSON
    }
    if (o?.type !== "assistant") continue;
    const content = o?.message?.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const b = content[j];
      if (b?.type === "tool_use" && b?.name === "Bash" && typeof b?.input?.command === "string") {
        return bashWorkingDir(b.input.command, worktree);
      }
    }
  }
  return null;
}

export interface WorktreeMonitorOptions {
  worktree: string;
  repoRoot: string;
  branch: string;
  events?: HydraEvents;
  logger?: (m: string) => void;
  /** Periodic check-in interval (ms). Default 20s. Set 0 to disable the timer. */
  intervalMs?: number;
}

/**
 * Live + post-run worktree containment monitor for one worker. `start()` snapshots
 * the primary checkout and begins periodic check-ins; `observeStreamLine()` feeds
 * real-time tool calls (streaming runner only); `finalize()` stops the timer and
 * returns any commits that strayed onto the primary checkout.
 */
export class WorktreeMonitor {
  private snap: PrimarySnapshot = { branch: "HEAD", head: "" };
  private timer: ReturnType<typeof setInterval> | undefined;
  private warnedDirs = new Set<string>();
  private primaryWarned = false;

  constructor(private readonly opts: WorktreeMonitorOptions) {}

  async start(): Promise<void> {
    this.snap = await snapshotPrimary(this.opts.repoRoot);
    const ms = this.opts.intervalMs ?? 20_000;
    if (ms > 0) {
      this.timer = setInterval(() => void this.tick().catch(() => {}), ms);
      this.timer.unref?.(); // never keep the process alive on the monitor alone
    }
  }

  private offtrack(detail: string, cwd?: string): void {
    this.opts.events?.emitEvent({ type: "agent:offtrack", branch: this.opts.branch, cwd, detail });
    this.opts.logger?.(`⚠ ${this.opts.branch}: ${detail}`);
  }

  private flagDir(dir: string, how: string): void {
    if (isInsideWorktree(dir, this.opts.worktree) || this.warnedDirs.has(dir)) return;
    this.warnedDirs.add(dir);
    this.offtrack(`${how} from ${dir} — OUTSIDE its worktree (${this.opts.worktree})`, dir);
  }

  /** Periodic check-in: where is the agent working, and did the primary checkout
   *  move under it? */
  async tick(): Promise<void> {
    const dir = await latestAgentDir(this.opts.worktree);
    if (dir) this.flagDir(dir, "working");
    const stray = await strayCommits(this.opts.repoRoot, this.snap);
    if (stray.length && !this.primaryWarned) {
      this.primaryWarned = true;
      this.offtrack(
        `${stray.length} commit(s) landed on the primary checkout (${this.snap.branch}) while this worker ran` +
          ` — likely committed outside the worktree: ${stray.map((c) => c.sha.slice(0, 8)).join(", ")}`,
      );
    }
  }

  /** Feed one raw stdout line (stream-json) for real-time escape detection. */
  observeStreamLine(line: string): void {
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    if (o?.type !== "assistant") return;
    const content = o?.message?.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b?.type === "tool_use" && b?.name === "Bash" && typeof b?.input?.command === "string") {
        this.flagDir(bashWorkingDir(b.input.command, this.opts.worktree), "ran a command");
      }
    }
  }

  /** Stop the timer and report any commits that strayed onto the primary checkout. */
  async finalize(): Promise<{ stray: StrayCommit[]; primaryBranch: string }> {
    if (this.timer) clearInterval(this.timer);
    const stray = await strayCommits(this.opts.repoRoot, this.snap);
    return { stray, primaryBranch: this.snap.branch };
  }
}

/**
 * Build the worker's terminal result after the agent exits, accounting for work
 * that may have escaped onto the primary checkout. When the branch advanced it's a
 * normal success; when it didn't but commits strayed, the error names them (so the
 * dashboard shows the real cause instead of a misleading "produced no commits").
 */
export function sanityCheckResult(args: {
  branch: string;
  before: string;
  head: string;
  stray: StrayCommit[];
  primaryBranch: string;
  context?: string;
}): { ok: true; head: string; context?: string } | { ok: false; error: string } {
  const { branch, before, head, stray, primaryBranch, context } = args;
  if (head !== before) return { ok: true, head, context };
  if (stray.length) {
    const shas = stray.map((c) => c.sha.slice(0, 8)).join(", ");
    return {
      ok: false,
      error:
        `agent produced no commits on ${branch}, but ${stray.length} commit(s) appeared on ` +
        `${primaryBranch} during the run — it committed OUTSIDE its worktree. ` +
        `Recover from the primary checkout: ${shas}`,
    };
  }
  return { ok: false, error: "agent produced no commits" };
}
