import path from "node:path";
import { Registry } from "./registry.js";
import { CheckpointManager } from "./checkpoint.js";
import { Git } from "./git.js";

/** One commit developed on a branch. */
export interface BranchCommit {
  sha: string;
  subject: string;
  date: string;
}

/**
 * A full historical record of one branch the hydra developed — its
 * orchestration state, the brief it was given, the agent's distilled summary,
 * and the actual commits it produced (those diverging from main).
 */
export interface BranchLogEntry {
  branch: string;
  taskId?: string;
  state?: string;
  head?: string;
  error?: string;
  updatedAt?: string;
  /** The task brief handed to the worker (from its checkpoint). */
  description?: string;
  /** The worker's handed-back context — decisions, intent, gotchas. */
  context?: string;
  createdAt?: string;
  /** True if the branch head is already an ancestor of main (landed). */
  merged: boolean;
  commits: BranchCommit[];
}

const UNIT_SEP = "\x1f";

/**
 * Build the full branch log: every branch the orchestrator scheduled (registry)
 * unioned with every branch that has a durable checkpoint, enriched with the
 * commits each branch developed relative to main. Read-only over .hydra +
 * git; the order is most-recently-updated first.
 */
export async function readBranchLog(repoRoot: string): Promise<BranchLogEntry[]> {
  const dir = path.join(repoRoot, ".hydra");
  const registry = await Registry.open(path.join(dir, "registry.json"));
  const cpm = new CheckpointManager(path.join(dir, "checkpoints"));
  const checkpoints = await cpm.list();
  const cpByBranch = new Map(checkpoints.map((c) => [c.branch, c]));

  const git = new Git(repoRoot);
  const mainRef = (await git.tryRun(["rev-parse", "--verify", "--quiet", "main"])).code === 0
    ? "main"
    : "HEAD";

  // Map each merge commit's second parent (the merged-in branch tip) -> its
  // first parent (main just before the merge). This recovers a merged branch's
  // own commits as `firstParent..tip`, which a plain merge-base can't once the
  // branch is folded into main.
  const mergedTipBase = new Map<string, string>();
  const mlog = await git.tryRun(["log", "--merges", "--pretty=%H %P", "-n", "1000", mainRef]);
  if (mlog.code === 0) {
    for (const line of mlog.stdout.split("\n")) {
      const parts = line.trim().split(/\s+/);
      const p1 = parts[1], p2 = parts[2];
      if (p1 && p2 && !mergedTipBase.has(p2)) mergedTipBase.set(p2, p1);
    }
  }

  // Union of branches from the registry and from checkpoints.
  const branches = new Set<string>();
  for (const e of registry.all()) branches.add(e.branch);
  for (const c of checkpoints) branches.add(c.branch);

  const entries: BranchLogEntry[] = [];
  for (const branch of branches) {
    const reg = registry.all().find((e) => e.branch === branch);
    const cp = cpByBranch.get(branch);
    const head = reg?.head ?? cp?.head;

    // Prefer the live branch ref; fall back to the recorded head sha so the log
    // still resolves commits after a worktree/branch is cleaned up.
    let ref = "";
    if ((await git.tryRun(["rev-parse", "--verify", "--quiet", branch])).code === 0) ref = branch;
    else if (head && (await git.tryRun(["rev-parse", "--verify", "--quiet", head])).code === 0) ref = head;

    const fullHead = head ?? (ref ? (await git.tryRun(["rev-parse", ref])).stdout.trim() : "");
    let commits: BranchCommit[] = [];
    let merged = false;
    if (ref || fullHead) {
      const lref = ref || fullHead;
      // Prefer the integration merge's base (works after the branch lands);
      // otherwise the merge-base with main (works while still in flight).
      let base = fullHead && mergedTipBase.get(fullHead);
      if (!base) {
        const baseR = await git.tryRun(["merge-base", mainRef, lref]);
        if (baseR.code === 0 && baseR.stdout.trim()) base = baseR.stdout.trim();
      }
      const range = base ? `${base}..${lref}` : lref;
      const logR = await git.tryRun(["log", `--format=%h${UNIT_SEP}%s${UNIT_SEP}%cI`, "-n", "100", range]);
      if (logR.code === 0) {
        commits = logR.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const [sha, subject, date] = l.split(UNIT_SEP);
            return { sha: sha ?? "", subject: subject ?? "", date: date ?? "" };
          });
      }
      merged = !!fullHead && (await git.tryRun(["merge-base", "--is-ancestor", fullHead, mainRef])).code === 0;
    }

    entries.push({
      branch,
      taskId: reg?.taskId ?? cp?.taskId,
      state: reg?.state,
      head,
      error: reg?.error,
      updatedAt: reg?.updatedAt,
      description: cp?.description,
      context: cp?.context,
      createdAt: cp?.createdAt,
      merged,
      commits,
    });
  }

  entries.sort((a, b) => {
    const ta = a.updatedAt ?? a.createdAt ?? "";
    const tb = b.updatedAt ?? b.createdAt ?? "";
    return ta < tb ? 1 : ta > tb ? -1 : 0;
  });
  return entries;
}
