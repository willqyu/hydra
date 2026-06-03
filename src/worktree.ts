import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Git } from "./git.js";

export interface WorktreeInfo {
  path: string;
  branch?: string;
  head?: string;
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

  /** Create a worktree on a NEW branch `branch` based at `baseRef`. */
  async add(branch: string, baseRef: string): Promise<string> {
    await mkdir(this.baseDir, { recursive: true });
    const wt = this.pathFor(branch);
    await this.git.run(["worktree", "add", "-b", branch, wt, baseRef]);
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
