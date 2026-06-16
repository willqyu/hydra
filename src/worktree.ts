import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Git } from "./git.js";

export interface WorktreeInfo {
  path: string;
  branch?: string;
  head?: string;
}

/**
 * Thrown by `add` when the target branch already exists AND is held by a live
 * worktree — i.e. another worker (often a duplicate/concurrent spawn) already
 * owns it. The caller should bow out WITHOUT recording a failure, so it doesn't
 * clobber the owning worker's result.
 */
export class BranchBusyError extends Error {
  constructor(public readonly branch: string) {
    super(`branch ${branch} is already owned by a live worker`);
    this.name = "BranchBusyError";
  }
}

/** Manages git worktrees — cheap per-branch isolation on a single machine. */
export class WorktreeManager {
  private readonly git: Git;

  constructor(
    public readonly repoRoot: string,
    public readonly baseDir: string,
  ) {
    this.git = new Git(repoRoot);
  }

  /** Filesystem path this manager will use for a branch's worktree. */
  pathFor(branch: string): string {
    const safe = branch.replace(/[^a-zA-Z0-9._-]/g, "_");
    return path.join(this.baseDir, safe);
  }

  /**
   * Create a worktree on a NEW branch `branch` based at `baseRef`. If the branch
   * already exists we don't hard-fail (that's what stranded finished work as
   * "failed"): a live worktree means another worker owns it → BranchBusyError so
   * the caller bows out cleanly; otherwise we attach to the existing branch and
   * continue on top of its commits.
   */
  async add(branch: string, baseRef: string): Promise<string> {
    await mkdir(this.baseDir, { recursive: true });
    const wt = this.pathFor(branch);
    const created = await this.git.tryRun(["worktree", "add", "-b", branch, wt, baseRef]);
    if (created.code === 0) return wt;

    const branchExists =
      (await this.git.tryRun(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
    if (!branchExists) {
      throw new Error(
        `git worktree add -b ${branch} ${wt} ${baseRef} failed: ${(created.stderr || created.stdout).trim()}`,
      );
    }
    // `worktree add -b` creates branch+worktree atomically, so if the branch now
    // exists a concurrent winner already has it checked out — detect that.
    const live = (await this.list()).some((w) => w.branch === branch && w.path !== this.repoRoot);
    if (live) throw new BranchBusyError(branch);
    return this.addExisting(branch);
  }

  /** Create a worktree that checks out an EXISTING branch (commits stack onto
   *  it). Used to continue an un-integrated branch in place. Falls back to
   *  --force when the branch is already checked out in another worktree. */
  async addExisting(branch: string): Promise<string> {
    await mkdir(this.baseDir, { recursive: true });
    const wt = this.pathFor(branch);
    await this.remove(branch, { force: true }).catch(() => {}); // clear any stale worktree
    const r = await this.git.tryRun(["worktree", "add", wt, branch]);
    if (r.code !== 0) {
      // Branch may be checked out elsewhere (e.g. the user checked it into the
      // main tree). Force a second checkout so the continuation can proceed.
      await this.git.run(["worktree", "add", "--force", wt, branch]);
    }
    return wt;
  }

  /** Remove the worktree directory; the branch ref is retained. */
  async remove(branch: string, opts: { force?: boolean } = {}): Promise<void> {
    const wt = this.pathFor(branch);
    const args = ["worktree", "remove"];
    if (opts.force) args.push("--force");
    args.push(wt);
    const r = await this.git.tryRun(args);
    if (r.code !== 0) {
      // Directory may already be gone; prune stale administrative entries.
      await this.git.tryRun(["worktree", "prune"]);
    }
  }

  /** All worktrees registered for this repo (including the main one). */
  async list(): Promise<WorktreeInfo[]> {
    const out = await this.git.run(["worktree", "list", "--porcelain"]);
    const infos: WorktreeInfo[] = [];
    let cur: WorktreeInfo | null = null;
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (cur) infos.push(cur);
        cur = { path: line.slice("worktree ".length) };
      } else if (line.startsWith("HEAD ") && cur) {
        cur.head = line.slice("HEAD ".length);
      } else if (line.startsWith("branch ") && cur) {
        cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      } else if (line === "") {
        if (cur) infos.push(cur);
        cur = null;
      }
    }
    if (cur) infos.push(cur);
    return infos;
  }
}
