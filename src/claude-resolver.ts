import { readFile } from "node:fs/promises";
import path from "node:path";
import { runClaude } from "./claude.js";
import type { ConflictResolver, ConflictFile, ResolutionRequest, ResolutionProposal } from "./resolver.js";

export interface ClaudeConflictResolverOptions {
  name?: string;
  bin?: string;
  args?: string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
}

function textualPrompt(req: ResolutionRequest): string {
  return [
    `You are resolving a git merge conflict while integrating branch "${req.branch}".`,
    `Round ${req.round}. Working directory is the integration worktree.`,
    req.feedback ? `\nPrevious attempt was rejected:\n${req.feedback}\n` : "",
    "Conflicted files (with conflict markers):",
    ...req.conflictedFiles.map((f) => `- ${f.path}`),
    "",
    "Edit the files in place to a correct, merged result. Remove ALL conflict",
    "markers (<<<<<<<, =======, >>>>>>>). Do NOT commit — just leave the resolved",
    "files on disk.",
  ].join("\n");
}

function semanticPrompt(req: ResolutionRequest): string {
  return [
    `Branch "${req.branch}" merged cleanly but the test gate is failing — a`,
    "semantic conflict (e.g. a renamed/removed symbol another branch still uses).",
    `Round ${req.round}. Working directory is the integration worktree.`,
    "",
    "Failing test output:",
    req.testOutput ?? req.feedback ?? "(none)",
    "",
    "Fix the integrated code in place so the tests pass. Do NOT commit — just",
    "leave the fixed files on disk.",
  ].join("\n");
}

/**
 * Conflict resolver backed by a real Claude Code agent. It runs `claude` in the
 * integration worktree, lets the agent edit files in place to resolve the
 * conflict, then reads the touched files back as its proposal. The Negotiator
 * still owns the gate: markers-gone + tests-pass before anything is committed.
 */
export class ClaudeConflictResolver implements ConflictResolver {
  readonly name: string;
  constructor(private readonly opts: ClaudeConflictResolverOptions = {}) {
    this.name = opts.name ?? "claude";
  }

  async propose(req: ResolutionRequest): Promise<ResolutionProposal> {
    const prompt = req.kind === "textual" ? textualPrompt(req) : semanticPrompt(req);
    const res = await runClaude({
      cwd: req.worktree,
      prompt,
      bin: this.opts.bin,
      args: this.opts.args,
      timeoutMs: this.opts.timeoutMs,
      env: this.opts.env,
      shell: this.opts.shell,
    });

    // Read back the files the agent was asked to touch (textual case). For
    // semantic conflicts we don't know which files changed, so we return none
    // and let the gate evaluate the agent's in-place edits directly.
    const files: ConflictFile[] = [];
    for (const f of req.conflictedFiles) {
      try {
        files.push({ path: f.path, content: await readFile(path.join(req.worktree, f.path), "utf8") });
      } catch {
        // file removed by the resolution — skip
      }
    }
    return { files, note: `claude resolver (exit ${res.code}): ${firstLine(res.stdout)}` };
  }
}

function firstLine(s: string): string {
  return (s.split("\n").find((l) => l.trim()) ?? "").slice(0, 120);
}
