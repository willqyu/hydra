import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export const CONFIG_ROLES = ["worker", "supervisor", "negotiator"] as const;
export type AgentRole = (typeof CONFIG_ROLES)[number];

/**
 * Per-repo harness defaults, persisted at .harness/config.json and edited from
 * the dashboard's Settings page. Prompts are APPENDED to each agent's built-in
 * brief (via `claude --append-system-prompt`), never replacing it; models go
 * through `claude --model`. Empty = the CLI's own default.
 */
export interface HarnessConfig {
  prompts: Partial<Record<AgentRole, string>>;
  models: Partial<Record<AgentRole, string>>;
}

function configFile(repoRoot: string): string {
  return path.join(repoRoot, ".harness", "config.json");
}

/** Keep only known roles and safe values — a model name must look like a model
 *  name, not a CLI flag, since it lands in a spawn argv. */
export function sanitizeConfig(raw: unknown): HarnessConfig {
  const r = (raw ?? {}) as { prompts?: Record<string, unknown>; models?: Record<string, unknown> };
  const cfg: HarnessConfig = { prompts: {}, models: {} };
  for (const role of CONFIG_ROLES) {
    const p = r.prompts?.[role];
    if (typeof p === "string" && p.trim()) cfg.prompts[role] = p.trim();
    const m = r.models?.[role];
    if (typeof m === "string" && /^[a-zA-Z0-9][\w.:@-]*$/.test(m.trim())) cfg.models[role] = m.trim();
  }
  return cfg;
}

export async function loadConfig(repoRoot: string): Promise<HarnessConfig> {
  try {
    return sanitizeConfig(JSON.parse(await readFile(configFile(repoRoot), "utf8")));
  } catch {
    return { prompts: {}, models: {} };
  }
}

export async function saveConfig(repoRoot: string, raw: unknown): Promise<HarnessConfig> {
  const cfg = sanitizeConfig(raw);
  await mkdir(path.dirname(configFile(repoRoot)), { recursive: true });
  await writeFile(configFile(repoRoot), JSON.stringify(cfg, null, 2), "utf8");
  return cfg;
}

/** Extra `claude` CLI args applying one role's configured model + system prompt. */
export function roleArgs(cfg: HarnessConfig, role: AgentRole): string[] {
  const out: string[] = [];
  const model = cfg.models[role];
  const prompt = cfg.prompts[role];
  if (model) out.push("--model", model);
  if (prompt) out.push("--append-system-prompt", prompt);
  return out;
}
