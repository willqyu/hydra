import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * Sticky, per-repo dashboard session state, persisted at .hydra/session.json.
 * Its one job today is the ACTIVE INTEGRATION TARGET: the branch that agent work
 * spawned from this session should ultimately land in. Once set, every subsequent
 * spawn tags its tasks with this target and the Integrate action defaults to it —
 * so a whole session of agents assembles onto one chosen branch instead of main,
 * until the target is changed or cleared. This is distinct from each worker's own
 * isolated work branch/worktree (that's still one-per-task, as always).
 */
export interface SessionState {
  /** Active integration target branch. Empty/absent = fall back to the repo trunk
   *  (main/master). May name a branch that does not exist yet — the integrator
   *  creates it off the trunk lazily, when the merge-train first runs. */
  targetBranch?: string;
}

function sessionFile(repoRoot: string): string {
  return path.join(repoRoot, ".hydra", "session.json");
}

/** Coerce arbitrary input into a safe branch name, or "" if unusable/cleared. */
export function sanitizeTarget(b: unknown): string {
  return String(b ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._/-]/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function loadSession(repoRoot: string): Promise<SessionState> {
  try {
    const raw = JSON.parse(await readFile(sessionFile(repoRoot), "utf8"));
    const t = sanitizeTarget(raw?.targetBranch);
    return t ? { targetBranch: t } : {};
  } catch {
    return {};
  }
}

/** Persist the session; an empty/blank target clears it (back to the trunk). */
export async function saveSession(repoRoot: string, state: SessionState): Promise<SessionState> {
  const t = sanitizeTarget(state.targetBranch);
  const clean: SessionState = t ? { targetBranch: t } : {};
  await mkdir(path.dirname(sessionFile(repoRoot)), { recursive: true });
  await writeFile(sessionFile(repoRoot), JSON.stringify(clean, null, 2), "utf8");
  return clean;
}
