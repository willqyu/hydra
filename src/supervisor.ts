import { runClaude } from "./claude.js";
import type { TaskSpec } from "./types.js";

export interface SupervisorOptions {
  /** Repo the work targets — the supervisor inspects it to plan around the code. */
  repoRoot: string;
  bin?: string;
  args?: string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  logger?: (m: string) => void;
}

export interface SupervisorPlan {
  /** True when the task is small enough for a single worker on one branch. */
  single: boolean;
  /** The planned tasks (one when single, ≥2 when decomposed). */
  tasks: TaskSpec[];
  /** The supervisor's one-line reasoning, surfaced to the user. */
  rationale?: string;
}

function slug(s: string, n = 28): string {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, n) || "task"
  );
}

// The behavioral heuristics (when to split, minimize overlap, priorities, …)
// ship as the supervisor's system prompt (config DEFAULT_PROMPTS.supervisor) and
// are editable in Settings. This seed keeps only the task and the strict JSON
// output contract the parser depends on.
function planPrompt(description: string): string {
  return [
    "A user has given you ONE task for a parallel multi-agent coding hydra. Decide",
    "whether it should be done by a SINGLE worker on one branch, or split across",
    "MULTIPLE workers — each on its own git branch/worktree, running in parallel and",
    "integrated later via a merge-train.",
    "",
    "The user's task:",
    description,
    "",
    "Respond with ONLY a single JSON object (no prose, no code fences) of the form:",
    '{"single": false, "rationale": "<one line>", "tasks": [',
    '  {"id": "kebab-id", "branch": "feat/x", "description": "<self-contained brief for this worker>", "blockedBy": [], "priority": 1}',
    "]}",
    "",
    'For a single worker return {"single": true, "rationale": "...", "tasks": [ {"id","branch","description","priority":1} ]}.',
    "Each description must be a COMPLETE brief — the worker sees only it, not this prompt.",
  ].join("\n");
}

/** Pull the first balanced top-level JSON object out of an agent's stdout. */
function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Normalize the agent's parsed plan into validated TaskSpecs with unique ids/branches. */
function normalizePlan(raw: any, description: string): SupervisorPlan {
  const rawTasks: any[] = Array.isArray(raw?.tasks) ? raw.tasks : [];
  const ids = new Set<string>();
  const branches = new Set<string>();
  const tasks: TaskSpec[] = [];
  for (const t of rawTasks) {
    if (!t || typeof t.description !== "string" || !t.description.trim()) continue;
    let id = slug(t.id || t.branch || t.description, 24);
    while (ids.has(id)) id = `${id}-${ids.size}`;
    ids.add(id);
    let branch = typeof t.branch === "string" && t.branch.trim() ? t.branch.trim() : `agent/${id}`;
    branch = branch.replace(/[^a-zA-Z0-9._/-]/g, "-");
    while (branches.has(branch)) branch = `${branch}-2`;
    branches.add(branch);
    const blockedBy = Array.isArray(t.blockedBy) ? t.blockedBy.map((d: unknown) => slug(String(d), 24)) : [];
    const priority = Number.isFinite(t.priority) ? Math.max(1, Math.round(t.priority)) : 3;
    tasks.push({ id, branch, description: t.description.trim(), blockedBy, priority });
  }
  // Drop blockedBy ids that don't resolve to a planned task (agent drift).
  for (const t of tasks) t.blockedBy = (t.blockedBy ?? []).filter((d) => ids.has(d) && d !== t.id);

  const single = raw?.single === true || tasks.length <= 1;
  return { single, tasks, rationale: typeof raw?.rationale === "string" ? raw.rationale : undefined };
}

/**
 * Ask a supervisor agent whether a task needs one worker or a fleet, and — when a
 * fleet — to decompose it into low-overlap, prioritized branches. Falls back to a
 * single task if the agent fails or returns nothing usable.
 */
export async function superviseTask(description: string, opts: SupervisorOptions): Promise<SupervisorPlan> {
  const log = opts.logger ?? (() => {});
  log("supervisor: planning…");
  const res = await runClaude({
    cwd: opts.repoRoot,
    prompt: planPrompt(description),
    bin: opts.bin,
    args: opts.args,
    timeoutMs: opts.timeoutMs,
    env: opts.env,
    shell: opts.shell,
  });
  const parsed = extractJson(res.stdout);
  if (!parsed) {
    log("supervisor: no plan parsed — falling back to a single worker");
    return singleFallback(description);
  }
  const plan = normalizePlan(parsed, description);
  if (!plan.tasks.length) return singleFallback(description);
  log(
    plan.single
      ? `supervisor: single worker — ${plan.rationale ?? ""}`
      : `supervisor: ${plan.tasks.length} branches — ${plan.rationale ?? ""}`,
  );
  return plan;
}

function namePrompt(description: string): string {
  return [
    "Summarize the following task as a git branch name. Use a conventional prefix",
    "(feat/, fix/, chore/, docs/, refactor/) followed by a short kebab-case summary",
    "of WHAT the task does — 2 to 5 words. Example: feat/csv-user-export.",
    "Respond with ONLY the branch name on a single line, nothing else.",
    "",
    "Task:",
    description,
  ].join("\n");
}

/** Coerce an agent's reply into a safe branch name, or "" if unusable. */
function sanitizeBranchName(out: string): string {
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  let cand = lines.length ? lines[lines.length - 1]! : "";
  cand = cand
    .replace(/[`"'*]/g, "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9/_-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "");
  if (cand.length > 48) cand = cand.slice(0, 48).replace(/[-/]+$/, "");
  if (!cand) return "";
  return cand.includes("/") ? cand : `agent/${cand}`;
}

/**
 * Ask a Claude agent to summarize a task into a concise branch name, instead of
 * naively slugging its first few words. Falls back to the slug if the agent
 * fails or returns nothing usable.
 */
export async function nameBranch(description: string, opts: SupervisorOptions): Promise<string> {
  const log = opts.logger ?? (() => {});
  const res = await runClaude({
    cwd: opts.repoRoot,
    prompt: namePrompt(description),
    bin: opts.bin,
    args: opts.args,
    timeoutMs: opts.timeoutMs ?? 2 * 60 * 1000,
    env: opts.env,
    shell: opts.shell,
  });
  const name = sanitizeBranchName(res.stdout) || `agent/${slug(description)}`;
  log(`named branch: ${name}`);
  return name;
}

/** The deterministic one-task plan used when no supervisor is run or it fails.
 *  `nameFrom` provides the id/branch slug when the prompt itself is a wrapper
 *  (e.g. a continuation) that wouldn't make a sensible branch name. */
export function singleFallback(description: string, branch?: string, nameFrom?: string): SupervisorPlan {
  const id = slug(branch || nameFrom || description, 24);
  return {
    single: true,
    tasks: [{ id, branch: branch || `agent/${id}`, description, priority: 1 }],
  };
}
