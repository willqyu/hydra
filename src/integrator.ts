import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { Git } from "./git.js";
import { MergeTool } from "./merge.js";
import { WorktreeManager } from "./worktree.js";
import { execShell } from "./exec.js";
import { HarnessEvents } from "./events.js";

/** Result of asking a negotiator to resolve a conflict. */
export interface ConflictResolution {
  resolved: boolean;
  /** True when the negotiator gave up and the conflict needs human/orchestrator judgement. */
  escalated?: boolean;
  detail?: string;
}

export interface TextualConflictInput {
  /** Git scoped to the integration worktree (mid-merge, with conflict markers). */
  worktreeGit: Git;
  worktree: string;
  /** The branch being merged in. */
  branch: string;
  /** Files left in conflict by the failed merge. */
  conflictedFiles: string[];
  /** Command that decides success after a resolution, if any. */
  testCommand?: string;
}

export interface SemanticConflictInput {
  worktreeGit: Git;
  worktree: string;
  /** The branch whose (clean) merge nevertheless broke the test gate. */
  branch: string;
  /** Output of the failing test command. */
  testOutput: string;
  testCommand?: string;
}

/**
 * Resolves conflicts during integration. Implemented by the M3 Negotiator;
 * the Integrator treats it as an optional collaborator so M2 (clean-path
 * integration + test gate) works standalone.
 */
export interface Negotiator {
  resolveTextual(input: TextualConflictInput): Promise<ConflictResolution>;
  resolveSemantic(input: SemanticConflictInput): Promise<ConflictResolution>;
}

export interface IntegratorOptions {
  repoRoot: string;
  /** Branch we ultimately promote to. Default "main". */
  mainBranch?: string;
  /** Staging branch where branches are assembled + tested. Default "integration/staging". */
  integrationBranch?: string;
  /** Command run in the integration worktree after each merge. Empty => skip gate. */
  testCommand?: string;
  testTimeoutMs?: number;
  worktreeDir?: string;
  /** Conflict resolver (M3+). When absent, any conflict stops the train. */
  negotiator?: Negotiator;
  /** Emits integrate:* / escalate events for the live UI. */
  events?: HarnessEvents;
  /** Where to persist the latest integration result. Default
   *  <repoRoot>/.harness/integration.json. Pass null to disable. */
  stateFile?: string | null;
  logger?: (m: string) => void;
}

export type StepStatus = "merged" | "resolved" | "conflict" | "test-failed" | "escalated";

export interface IntegrationStep {
  branch: string;
  status: StepStatus;
  conflictedFiles?: string[];
  detail?: string;
}

export interface IntegrationResult {
  promoted: boolean;
  mainHead?: string;
  steps: IntegrationStep[];
}

/**
 * Serialized merge-train: assembles task branches onto a staging branch one at a
 * time, runs the test gate after each merge (catching semantic breakage that a
 * clean textual merge hides), and fast-forwards `main` only when the whole train
 * is green. Whoever lands second faces the first's already-merged changes — which
 * is exactly why merges are serialized rather than done in parallel.
 */
export class Integrator {
  private readonly log: (m: string) => void;
  private readonly git: Git;
  private readonly mergeTool: MergeTool;
  private readonly wtm: WorktreeManager;
  private readonly main: string;
  private readonly integ: string;

  constructor(private readonly opts: IntegratorOptions) {
    this.log = opts.logger ?? (() => {});
    this.git = new Git(opts.repoRoot);
    this.mergeTool = new MergeTool(this.git);
    this.main = opts.mainBranch ?? "main";
    this.integ = opts.integrationBranch ?? "integration/staging";
    this.wtm = new WorktreeManager(
      opts.repoRoot,
      opts.worktreeDir ?? path.join(opts.repoRoot, ".harness", "worktrees"),
    );
  }

  /** Predict trouble before merging: which branches conflict with `main` as-is. */
  async preflight(branches: string[]): Promise<Record<string, string[]>> {
    const report: Record<string, string[]> = {};
    for (const b of branches) {
      const c = await this.mergeTool.detectConflicts(this.main, b);
      if (!c.clean) report[b] = c.conflictedFiles;
    }
    return report;
  }

  async integrate(branches: string[]): Promise<IntegrationResult> {
    const steps: IntegrationStep[] = [];
    const wtPath = this.wtm.pathFor(this.integ);
    this.opts.events?.emitEvent({ type: "integrate:start", branches });

    // Fresh staging branch at main, in its own worktree.
    await this.wtm.remove(this.integ, { force: true }).catch(() => {});
    await this.git.run(["branch", "-f", this.integ, this.main]);
    await this.git.run(["worktree", "add", wtPath, this.integ]);
    const wtGit = new Git(wtPath);

    const recordStep = (step: IntegrationStep, replaceLast = false): void => {
      if (replaceLast) steps[steps.length - 1] = step;
      else steps.push(step);
      this.opts.events?.emitEvent({
        type: "integrate:step",
        branch: step.branch,
        status: step.status,
        detail: step.detail,
      });
    };

    try {
      for (const branch of branches) {
        this.log(`⇢ merging ${branch} into ${this.integ}`);
        const merge = await this.mergeTool.mergeInto(wtGit, branch, `integrate ${branch}`);

        if (!merge.merged) {
          const step = await this.handleTextualConflict(wtGit, wtPath, branch, merge.conflictedFiles);
          recordStep(step);
          if (step.status !== "resolved") {
            return await this.finish({ promoted: false, steps }); // train halts; main untouched
          }
        } else {
          recordStep({ branch, status: "merged" });
        }

        // Test gate after every merge — this is where semantic conflicts surface.
        if (this.opts.testCommand) {
          const t = await execShell(this.opts.testCommand, wtPath, { timeoutMs: this.opts.testTimeoutMs });
          if (t.code !== 0) {
            const step = await this.handleSemanticConflict(wtGit, wtPath, branch, t.stdout + t.stderr);
            recordStep(step, true); // overwrite the just-pushed "merged" with the gate outcome
            if (step.status !== "resolved") {
              return await this.finish({ promoted: false, steps });
            }
          }
        }
      }

      // All green — fast-forward main to the staging head.
      const head = await wtGit.head();
      await this.git.run(["update-ref", `refs/heads/${this.main}`, head]);
      this.log(`✔ promoted ${this.main} -> ${head.slice(0, 8)}`);
      return await this.finish({ promoted: true, mainHead: head, steps });
    } finally {
      await this.wtm.remove(this.integ, { force: true }).catch(() => {});
    }
  }

  /** Emit the terminal event and persist the result for the UI to poll. */
  private async finish(result: IntegrationResult): Promise<IntegrationResult> {
    this.opts.events?.emitEvent({
      type: "integrate:done",
      promoted: result.promoted,
      mainHead: result.mainHead,
    });
    if (this.opts.stateFile !== null) {
      const file = this.opts.stateFile ?? path.join(this.opts.repoRoot, ".harness", "integration.json");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ ...result, updatedAt: new Date().toISOString() }, null, 2), "utf8");
    }
    return result;
  }

  private async handleTextualConflict(
    wtGit: Git,
    worktree: string,
    branch: string,
    conflictedFiles: string[],
  ): Promise<IntegrationStep> {
    if (!this.opts.negotiator) {
      await this.mergeTool.abortMerge(wtGit);
      this.log(`✘ conflict on ${branch}: ${conflictedFiles.join(", ")} (no negotiator)`);
      return { branch, status: "conflict", conflictedFiles };
    }
    const res = await this.opts.negotiator.resolveTextual({
      worktreeGit: wtGit,
      worktree,
      branch,
      conflictedFiles,
      testCommand: this.opts.testCommand,
    });
    if (res.resolved) return { branch, status: "resolved", detail: res.detail };
    await this.mergeTool.abortMerge(wtGit);
    return {
      branch,
      status: res.escalated ? "escalated" : "conflict",
      conflictedFiles,
      detail: res.detail,
    };
  }

  private async handleSemanticConflict(
    wtGit: Git,
    worktree: string,
    branch: string,
    testOutput: string,
  ): Promise<IntegrationStep> {
    if (!this.opts.negotiator) {
      this.log(`✘ test gate failed after merging ${branch} (no negotiator)`);
      return { branch, status: "test-failed", detail: testOutput.slice(0, 2000) };
    }
    const res = await this.opts.negotiator.resolveSemantic({
      worktreeGit: wtGit,
      worktree,
      branch,
      testOutput,
      testCommand: this.opts.testCommand,
    });
    if (res.resolved) return { branch, status: "resolved", detail: res.detail };
    return {
      branch,
      status: res.escalated ? "escalated" : "test-failed",
      detail: res.detail ?? testOutput.slice(0, 2000),
    };
  }
}
