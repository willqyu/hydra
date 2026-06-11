import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execShell } from "./exec.js";
import { IntraFleetBus } from "./bus.js";
import { HarnessEvents } from "./events.js";
import type { ConflictResolver, ConflictFile } from "./resolver.js";
import type {
  ConflictResolution,
  Negotiator as NegotiatorInterface,
  SemanticConflictInput,
  TextualConflictInput,
} from "./integrator.js";

const CONFLICT_MARKER = /^(<{7}|={7}|>{7})/m;

export interface NegotiatorOptions {
  /** Parties to the negotiation. Rounds rotate through them so different agents
   *  take turns proposing — A proposes, the gate rejects, B counters, and so on. */
  resolvers: ConflictResolver[];
  /** Max rounds before the tie-breaker / escalation. Default 3. */
  maxRounds?: number;
  /** The orchestrator's final-judge resolver. Gets one last attempt after the
   *  rounds are exhausted, before escalating to a human. */
  tieBreaker?: ConflictResolver;
  bus?: IntraFleetBus;
  events?: HarnessEvents;
  testTimeoutMs?: number;
  logger?: (m: string) => void;
  onEscalate?: (info: { branch: string; kind: "textual" | "semantic"; detail: string }) => void;
}

interface Attempt {
  resolver: ConflictResolver;
  round: number;
  tieBreak: boolean;
}

/**
 * Drives bounded-round, test-verified conflict resolution. A resolution is only
 * accepted when conflict markers are gone AND the test gate passes — chat
 * agreement alone never lands code. Sequence: bounded rounds → orchestrator
 * tie-break → human escalation. It never loops forever.
 */
export class Negotiator implements NegotiatorInterface {
  private readonly resolvers: ConflictResolver[];
  private readonly maxRounds: number;
  private readonly tieBreaker?: ConflictResolver;
  private readonly bus?: IntraFleetBus;
  private readonly events?: HarnessEvents;
  private readonly testTimeoutMs?: number;
  private readonly log: (m: string) => void;
  private readonly onEscalate?: NegotiatorOptions["onEscalate"];

  constructor(opts: NegotiatorOptions) {
    if (opts.resolvers.length === 0) throw new Error("Negotiator needs at least one resolver");
    this.resolvers = opts.resolvers;
    this.maxRounds = Math.max(1, opts.maxRounds ?? 3);
    this.tieBreaker = opts.tieBreaker;
    this.bus = opts.bus;
    this.events = opts.events;
    this.testTimeoutMs = opts.testTimeoutMs;
    this.log = opts.logger ?? (() => {});
    this.onEscalate = opts.onEscalate;
  }

  /** Ordered attempts: rotated resolvers for maxRounds, then the tie-breaker. */
  private attempts(): Attempt[] {
    const list: Attempt[] = [];
    for (let round = 1; round <= this.maxRounds; round++) {
      list.push({ resolver: this.resolvers[(round - 1) % this.resolvers.length]!, round, tieBreak: false });
    }
    if (this.tieBreaker) {
      list.push({ resolver: this.tieBreaker, round: this.maxRounds + 1, tieBreak: true });
    }
    return list;
  }

  async resolveTextual(input: TextualConflictInput): Promise<ConflictResolution> {
    const { worktreeGit, worktree, branch, conflictedFiles, testCommand } = input;
    let feedback: string | undefined;

    for (const { resolver, round, tieBreak } of this.attempts()) {
      this.announce(branch, round, resolver.name, tieBreak);
      const current = await this.readFiles(worktree, conflictedFiles);
      const proposal = await resolver.propose({
        branch, worktree, kind: "textual", round, conflictedFiles: current, feedback,
      });
      await this.applyProposal(worktree, proposal, resolver.name);

      const touched = unique([...conflictedFiles, ...proposal.files.map((f) => f.path)]);
      const markers = await this.filesWithMarkers(worktree, touched);
      if (markers.length > 0) {
        feedback = `unresolved conflict markers in: ${markers.join(", ")}`;
        this.bus?.post({ from: "gate", kind: "feedback", text: feedback });
        continue;
      }

      const gate = await this.runGate(worktree, testCommand);
      if (!gate.ok) {
        feedback = gate.output;
        this.bus?.post({ from: "gate", kind: "feedback", text: `tests failed in round ${round}` });
        continue;
      }

      await worktreeGit.run(["add", "-A"]);
      const committed = await worktreeGit.tryRun(["commit", "--no-edit"]);
      if (committed.code !== 0) {
        // Resolution produced no net change (e.g. the branch was already present).
        // That's not a failure — clear the dangling merge and accept the no-op
        // rather than throwing and aborting the whole train.
        if (/nothing to commit|no changes added/i.test(committed.stdout + committed.stderr)) {
          await worktreeGit.tryRun(["merge", "--abort"]).catch(() => {});
        } else {
          throw new Error(`commit failed: ${(committed.stderr || committed.stdout).trim()}`);
        }
      }
      return this.accept(branch, round, resolver.name, tieBreak);
    }

    return this.escalate(branch, "textual");
  }

  async resolveSemantic(input: SemanticConflictInput): Promise<ConflictResolution> {
    const { worktreeGit, worktree, branch, testOutput, testCommand } = input;
    let feedback = testOutput;

    for (const { resolver, round, tieBreak } of this.attempts()) {
      this.announce(branch, round, resolver.name, tieBreak);
      const proposal = await resolver.propose({
        branch, worktree, kind: "semantic", round, conflictedFiles: [], feedback, testOutput,
      });
      await this.applyProposal(worktree, proposal, resolver.name);

      const gate = await this.runGate(worktree, testCommand);
      if (!gate.ok) {
        feedback = gate.output;
        this.bus?.post({ from: "gate", kind: "feedback", text: `tests still failing in round ${round}` });
        continue;
      }

      await worktreeGit.run(["add", "-A"]);
      const status = await worktreeGit.run(["status", "--porcelain"]);
      if (status.trim()) await worktreeGit.run(["commit", "-m", `fix: integrate ${branch}`]);
      return this.accept(branch, round, resolver.name, tieBreak);
    }

    return this.escalate(branch, "semantic");
  }

  private announce(branch: string, round: number, resolver: string, tieBreak: boolean): void {
    this.bus?.post({
      from: resolver,
      kind: "propose",
      text: `${tieBreak ? "tie-break" : `round ${round}`}: ${branch}`,
    });
    this.events?.emitEvent({ type: "negotiate:round", branch, round, resolver, tieBreak });
  }

  private async applyProposal(
    worktree: string,
    proposal: { files: ConflictFile[]; note?: string },
    resolver: string,
  ): Promise<void> {
    await this.writeFiles(worktree, proposal.files);
    if (proposal.note) this.bus?.post({ from: resolver, kind: "note", text: proposal.note });
  }

  private accept(branch: string, round: number, resolver: string, tieBreak: boolean): ConflictResolution {
    const how = tieBreak ? `tie-break by ${resolver}` : `round ${round} by ${resolver}`;
    this.bus?.post({ from: resolver, kind: "resolved", text: `resolved ${branch} (${how})` });
    this.log(`✔ negotiated ${branch} (${how})`);
    return { resolved: true, detail: `resolved via ${how}` };
  }

  private escalate(branch: string, kind: "textual" | "semantic"): ConflictResolution {
    const tb = this.tieBreaker ? " and tie-break" : "";
    const detail = `exhausted ${this.maxRounds} rounds${tb} without a green resolution`;
    this.bus?.post({ from: "negotiator", kind: "escalated", text: `escalating ${branch}: ${detail}` });
    this.events?.emitEvent({ type: "escalate", branch, kind, detail });
    this.log(`⚠ escalating ${branch} (${kind}): ${detail}`);
    this.onEscalate?.({ branch, kind, detail });
    return { resolved: false, escalated: true, detail };
  }

  private async runGate(worktree: string, testCommand?: string): Promise<{ ok: boolean; output: string }> {
    if (!testCommand) return { ok: true, output: "" };
    const t = await execShell(testCommand, worktree, { timeoutMs: this.testTimeoutMs });
    return { ok: t.code === 0, output: truncate(t.stdout + t.stderr) };
  }

  private async readFiles(worktree: string, files: string[]): Promise<ConflictFile[]> {
    const out: ConflictFile[] = [];
    for (const p of files) {
      try {
        out.push({ path: p, content: await readFile(path.join(worktree, p), "utf8") });
      } catch {
        out.push({ path: p, content: "" });
      }
    }
    return out;
  }

  private async writeFiles(worktree: string, files: ConflictFile[]): Promise<void> {
    for (const f of files) await writeFile(path.join(worktree, f.path), f.content);
  }

  private async filesWithMarkers(worktree: string, files: string[]): Promise<string[]> {
    const hits: string[] = [];
    for (const p of files) {
      try {
        if (CONFLICT_MARKER.test(await readFile(path.join(worktree, p), "utf8"))) hits.push(p);
      } catch {
        // missing file — nothing to flag
      }
    }
    return hits;
  }
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function truncate(s: string, max = 4000): string {
  return s.length > max ? s.slice(0, max) + "\n…(truncated)" : s;
}
