import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export const CONFIG_ROLES = ["worker", "supervisor", "negotiator"] as const;
export type AgentRole = (typeof CONFIG_ROLES)[number];

/**
 * The standing system prompt each role ships with. These are the hydra's own
 * instructions for the role (the behavioral guidance that used to be baked into
 * each agent's seed brief); the dynamic/structural parts — branch, worktree,
 * task, the supervisor's JSON contract — still live in code. The Settings page
 * pre-fills its prompt boxes with these, so editing starts from what the agent
 * actually gets today rather than a blank box. A saved override replaces the
 * default for that role; clearing the box falls back here.
 */
export const DEFAULT_PROMPTS: Record<AgentRole, string> = {
  worker: [
    "You work EXCLUSIVELY inside your assigned worktree — the working directory named",
    "in your brief. This is a hard boundary: NEVER `cd` out of it, never read or write",
    "files under any other checkout, and never run git against another directory. Every",
    "path you touch is relative to your worktree. If the task text mentions an absolute",
    "repo path (e.g. /home/you/repo/src/...), treat it as living under YOUR worktree,",
    "not the original repo. Committing anywhere but your worktree silently corrupts the",
    "run: your branch ends up empty, the hydra reports you produced nothing, and your",
    "work is lost. When in doubt, run `pwd` and confirm you are inside your worktree",
    "before any git command.",
    "",
    "Implement the task end to end here, and commit INCREMENTALLY: after each logical",
    "step or working sub-change, run `git add -A && git commit` with a clear message —",
    "do NOT wait until the very end to make a single commit. Frequent commits keep your",
    "progress safe and make integration easier. Keep the change scoped to the task, and",
    "do NOT write a summary or wrap-up of your work at the end — just make the commits",
    "and stop when the task is done.",
  ].join("\n"),
  supervisor: [
    "You are the SUPERVISOR for a parallel multi-agent coding hydra. Split a task",
    "across multiple branches ONLY when it genuinely decomposes into parts that can",
    "progress independently, and design the split to MINIMIZE OVERLAP — partition by",
    "file/module/feature boundaries so two workers rarely touch the same lines",
    "(overlap manufactures merge conflicts). Put a real dependency in `blockedBy`",
    "when one part must build on another's output. Assign each task a `priority`",
    "(1 = highest); give core/foundational work the highest priority. Explore the",
    "repository as needed to ground the plan in the real code.",
  ].join("\n"),
  negotiator: [
    "You are a careful merge-conflict resolver, integrating one branch at a time.",
    "Aim for a minimal, correct result that preserves the intent of BOTH sides —",
    "never drop one side's work just to make the conflict go away. When a test gate",
    "guards the merge, prefer the smallest change that makes it pass.",
  ].join("\n"),
};

/**
 * Per-repo hydra defaults, persisted at .hydra/config.json and edited from
 * the dashboard's Settings page. Prompts are APPENDED to each agent's built-in
 * brief (via `claude --append-system-prompt`); an empty/absent role prompt falls
 * back to DEFAULT_PROMPTS for that role. Models go through `claude --model`;
 * empty = the CLI's own default.
 */
export interface HydraConfig {
  prompts: Partial<Record<AgentRole, string>>;
  models: Partial<Record<AgentRole, string>>;
}

/** The system prompt actually applied for a role: a saved override, else the default. */
export function effectivePrompt(cfg: HydraConfig, role: AgentRole): string {
  return cfg.prompts[role] ?? DEFAULT_PROMPTS[role];
}

function configFile(repoRoot: string): string {
  return path.join(repoRoot, ".hydra", "config.json");
}

/** A model name must look like a model name (alias or id), not a CLI flag, since
 *  it lands in a spawn argv. Returns the cleaned name, or "" if unusable. */
export function sanitizeModel(raw: unknown): string {
  const m = typeof raw === "string" ? raw.trim() : "";
  return /^[a-zA-Z0-9][\w.:@-]*$/.test(m) ? m : "";
}

/** Keep only known roles and safe values. */
export function sanitizeConfig(raw: unknown): HydraConfig {
  const r = (raw ?? {}) as { prompts?: Record<string, unknown>; models?: Record<string, unknown> };
  const cfg: HydraConfig = { prompts: {}, models: {} };
  for (const role of CONFIG_ROLES) {
    const p = r.prompts?.[role];
    if (typeof p === "string" && p.trim()) cfg.prompts[role] = p.trim();
    const m = sanitizeModel(r.models?.[role]);
    if (m) cfg.models[role] = m;
  }
  return cfg;
}

export async function loadConfig(repoRoot: string): Promise<HydraConfig> {
  try {
    return sanitizeConfig(JSON.parse(await readFile(configFile(repoRoot), "utf8")));
  } catch {
    return { prompts: {}, models: {} };
  }
}

export async function saveConfig(repoRoot: string, raw: unknown): Promise<HydraConfig> {
  const cfg = sanitizeConfig(raw);
  await mkdir(path.dirname(configFile(repoRoot)), { recursive: true });
  await writeFile(configFile(repoRoot), JSON.stringify(cfg, null, 2), "utf8");
  return cfg;
}

/**
 * Extra `claude` CLI args applying one role's model + system prompt. The system
 * prompt is the role's effective prompt (override or default). `modelOverride`,
 * when given (e.g. a per-run model picked in the dashboard), wins over the
 * configured model for this invocation only.
 */
export function roleArgs(cfg: HydraConfig, role: AgentRole, modelOverride?: string): string[] {
  const out: string[] = [];
  const model = modelOverride?.trim() || cfg.models[role];
  const prompt = effectivePrompt(cfg, role);
  if (model) out.push("--model", model);
  if (prompt) out.push("--append-system-prompt", prompt);
  return out;
}
