#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Git } from "./git.js";
import { Orchestrator } from "./orchestrator.js";
import { ClaudeAgentRunner } from "./worker.js";
import { StreamingClaudeAgentRunner, STREAMING_DEFAULT_ARGS } from "./streaming-worker.js";
import { loadConfig, roleArgs, type HarnessConfig } from "./config.js";
import { loadSession } from "./session.js";
import { InboxManager } from "./inbox.js";
import { Integrator } from "./integrator.js";
import { Negotiator } from "./negotiator.js";
import { ClaudeConflictResolver } from "./claude-resolver.js";
import { HarnessEvents } from "./events.js";
import { Registry } from "./registry.js";
import { CheckpointManager } from "./checkpoint.js";
import { superviseTask, singleFallback, nameBranch, type SupervisorPlan } from "./supervisor.js";
import { readFleetStatus, reconcileOrphanedWorkers } from "./status.js";
import { startServer } from "./server.js";
import type { TaskSpec } from "./types.js";

interface Flags {
  _: string[];
  [k: string]: string | boolean | string[];
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else {
      (flags._ as string[]).push(a);
    }
  }
  return flags;
}

const str = (f: Flags, k: string, d = ""): string => (typeof f[k] === "string" ? (f[k] as string) : d);
const num = (f: Flags, k: string, d: number): number => (typeof f[k] === "string" ? Number(f[k]) : d);

/** Resolve the integration trunk: main, else master, else the current branch. */
async function resolveMain(git: Git): Promise<string> {
  if ((await git.tryRun(["rev-parse", "--verify", "--quiet", "main"])).code === 0) return "main";
  if ((await git.tryRun(["rev-parse", "--verify", "--quiet", "master"])).code === 0) return "master";
  return (await git.tryRun(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim() || "HEAD";
}

/** Agent CLI args, with --dangerous enabling fully autonomous runs. */
function agentArgs(f: Flags): string[] {
  return f.dangerous
    ? ["-p", "--dangerously-skip-permissions"]
    : ["-p", "--permission-mode", "acceptEdits"];
}

/** Build the worker runner the run/plan commands share (interactive or one-shot).
 *  Applies the repo's configured default model + extra system prompt for workers. */
function makeRunner(f: Flags, events: HarnessEvents, cfg: HarnessConfig, modelOverride?: string) {
  // A per-run model (picked in the Spawn panel / `--model`) wins over config.
  const worker = roleArgs(cfg, "worker", modelOverride || str(f, "model") || undefined);
  if (f.interactive) {
    console.log("interactive mode — steer agents via `harness inject` or the dashboard");
    return new StreamingClaudeAgentRunner({
      bin: str(f, "agent-bin") || undefined,
      args: [...STREAMING_DEFAULT_ARGS, ...worker],
      events,
      ...(typeof f["idle-grace-ms"] === "string" ? { idleGraceMs: num(f, "idle-grace-ms", 120000) } : {}),
      logger: (m) => console.log("  " + m),
    });
  }
  return new ClaudeAgentRunner({
    bin: str(f, "agent-bin") || undefined,
    args: [...agentArgs(f), ...worker],
    events,
    logger: (m) => console.log("  " + m),
  });
}

async function runFleet(
  repo: string,
  tasks: TaskSpec[],
  f: Flags,
  opts: { concurrency?: number; baseRef?: string; model?: string } = {},
): Promise<void> {
  const events = logEvents();
  const cfg = await loadConfig(repo);
  const result = await new Orchestrator({
    repoRoot: repo,
    runner: makeRunner(f, events, cfg, opts.model),
    concurrency: num(f, "concurrency", opts.concurrency ?? 4),
    baseRef: str(f, "base") || opts.baseRef || undefined,
    events,
    logger: (m) => console.log(m),
  }).run(tasks);
  console.log(`\nrun complete: ${result.completed} ok, ${result.failed} failed`);
  if (result.skipped.length) console.log(`skipped (blocked): ${result.skipped.join(", ")}`);
}

async function cmdRun(f: Flags): Promise<void> {
  const repo = path.resolve(str(f, "repo", process.cwd()));
  const file = (f._ as string[])[1];
  if (!file) throw new Error("usage: harness run <tasks.json> [--repo .] [--concurrency N] [--base REF] [--dangerous]");
  const parsed = JSON.parse(await readFile(path.resolve(file), "utf8"));
  const tasks: TaskSpec[] = Array.isArray(parsed) ? parsed : parsed.tasks;
  // A file-level (or session) target applies to any task that didn't name its own.
  const target = (Array.isArray(parsed) ? undefined : parsed.targetBranch) || (await loadSession(repo)).targetBranch;
  if (target) for (const t of tasks) if (!t.targetBranch) t.targetBranch = target;
  await runFleet(repo, tasks, f, { concurrency: parsed.concurrency, baseRef: parsed.baseRef, model: parsed.model });
}

/**
 * Plan + run a single user request. Reads a request file
 * `{ description, branch?, mode?, continueFrom? }`, optionally invokes the
 * supervisor to decide single-vs-fleet (low-overlap, prioritized branches), and
 * when continuing a prior branch, seeds the worker with that branch's context
 * and forks from its head.
 */
async function cmdPlan(f: Flags): Promise<void> {
  const repo = path.resolve(str(f, "repo", process.cwd()));
  const reqFile = (f._ as string[])[1];
  if (!reqFile) throw new Error("usage: harness plan <request.json> [--repo .] [--dangerous]");
  const req = JSON.parse(await readFile(path.resolve(reqFile), "utf8")) as {
    description: string;
    branch?: string;
    mode?: "single" | "auto" | "split";
    continueFrom?: string;
    model?: string;
    targetBranch?: string;
  };
  if (!req.description?.trim()) throw new Error("request.description is required");

  const originalDesc = req.description.trim();
  let description = originalDesc;
  let baseRef: string | undefined;
  let preferredBranch = req.branch || undefined;
  // When continuing an UN-integrated branch, stack commits on it in place; only
  // fork a fresh branch when the source already landed in main.
  let attachBranch = false;
  const cfg = await loadConfig(repo);
  const supervisorArgs = [...agentArgs(f), ...roleArgs(cfg, "supervisor")];
  // Branch names come from a Claude summary of the task, not the first few words.
  const named = (d: string) => nameBranch(d, { repoRoot: repo, args: supervisorArgs, logger: (m) => console.log(m) });

  if (req.continueFrom) {
    const cont = await buildContinuation(repo, req.continueFrom, originalDesc);
    description = cont.description;
    baseRef = cont.baseRef;
    if (cont.merged) {
      preferredBranch = req.branch || (await named(originalDesc));
      console.log(`continuing from ${req.continueFrom} (already in main) — new branch ${preferredBranch}`);
    } else {
      preferredBranch = req.continueFrom; // same branch, in place
      attachBranch = true;
      console.log(`continuing ${req.continueFrom} in place (stacking commits)`);
    }
  }

  const mode = req.mode ?? "auto";
  let plan: SupervisorPlan;
  if (mode === "single") {
    const branch = preferredBranch || (await named(originalDesc));
    plan = singleFallback(description, branch, originalDesc);
  } else {
    plan = await superviseTask(description, {
      repoRoot: repo,
      args: supervisorArgs,
      logger: (m) => console.log(m),
    });
    // Honor an explicit/continuation branch name when the supervisor kept it single.
    if (plan.single && plan.tasks[0] && preferredBranch) plan.tasks[0].branch = preferredBranch;
  }
  // A single-task in-place continuation attaches to the existing branch.
  if (attachBranch && plan.single && plan.tasks[0]) plan.tasks[0].attachBranch = true;

  // Tag every planned task with the integration target so the whole fleet lands on
  // one branch: an explicit request target wins, else the session's active target.
  const targetBranch = req.targetBranch?.trim() || (await loadSession(repo)).targetBranch;
  if (targetBranch) for (const t of plan.tasks) t.targetBranch = targetBranch;

  console.log(
    plan.single
      ? `plan: 1 worker — ${plan.rationale ?? ""}`
      : `plan: ${plan.tasks.length} workers — ${plan.rationale ?? ""}`,
  );
  for (const t of plan.tasks) {
    console.log(`  • ${t.branch} (p${t.priority ?? "-"}${t.blockedBy?.length ? ", after " + t.blockedBy.join("+") : ""})`);
  }
  await runFleet(repo, plan.tasks, f, { baseRef, model: req.model });
}

/** Assemble a continuation brief from a prior branch's checkpoint + commits,
 *  and report whether that branch already landed in main. */
async function buildContinuation(
  repo: string,
  branch: string,
  newDescription: string,
): Promise<{ description: string; baseRef?: string; merged: boolean }> {
  const git = new Git(repo);
  const cpm = new CheckpointManager(path.join(repo, ".harness", "checkpoints"));
  const cp = await cpm.load(branch).catch(() => undefined);

  // Base the continuation on the live branch ref if present, else its checkpoint head.
  let baseRef: string | undefined;
  if ((await git.tryRun(["rev-parse", "--verify", "--quiet", branch])).code === 0) baseRef = branch;
  else if (cp?.head && (await git.tryRun(["rev-parse", "--verify", "--quiet", cp.head])).code === 0) baseRef = cp.head;

  const mainRef = (await git.tryRun(["rev-parse", "--verify", "--quiet", "main"])).code === 0 ? "main" : "HEAD";
  const merged = baseRef
    ? (await git.tryRun(["merge-base", "--is-ancestor", baseRef, mainRef])).code === 0
    : false;

  const parts = [
    `You are CONTINUING prior work that lives on branch "${branch}". Your worktree`,
    "already starts from that branch's latest commit, so all of its files and work",
    "are present here — build directly on top of them, do not start over.",
  ];
  if (cp?.description) parts.push("", "The original task this branch was given:", cp.description);
  if (cp?.context) parts.push("", "What the prior agent reported doing:", cp.context);
  parts.push(
    "",
    "YOUR NEW INSTRUCTION — make this change to the existing work and commit it:",
    newDescription,
  );
  return { description: parts.join("\n"), baseRef, merged };
}

async function cmdIntegrate(f: Flags): Promise<void> {
  const repo = path.resolve(str(f, "repo", process.cwd()));
  // Priority-ordered integration: highest-priority branches land first, and an
  // unresolvable lower-priority conflict is dropped instead of halting the train.
  const prioritized = !!f.prioritized;
  let branches = str(f, "branches")
    ? str(f, "branches").split(",").map((b) => b.trim()).filter(Boolean)
    : [];
  if (branches.length === 0) {
    // Repair any frozen `running` entries from crashed runs so finished-but-stuck
    // branches are integrated rather than silently skipped.
    await reconcileOrphanedWorkers(repo).catch(() => {});
    const reg = await Registry.open(path.join(repo, ".harness", "registry.json"));
    let completed = reg.all().filter((e) => e.state === "completed");
    if (prioritized) {
      completed = completed.sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
    }
    branches = completed.map((e) => e.branch);
  }
  if (branches.length === 0) throw new Error("no branches to integrate (pass --branches a,b or run first)");

  // Drop branches that no longer exist or have already landed in main. Re-merging
  // an already-integrated branch is a no-op that can spuriously fail the train and
  // strand genuinely-new branches behind it.
  const git = new Git(repo);
  const trunk = await resolveMain(git);
  // Target branch the fleet lands on: explicit --into/--main flag wins, else the
  // session's active target (set when the agents were spawned), else the trunk.
  // `--into` may name a branch that doesn't exist yet — the Integrator forks it
  // off the trunk. All merge/ancestor checks below run against this target.
  const session = await loadSession(repo);
  const mainBranch = str(f, "into") || str(f, "main") || session.targetBranch || trunk;
  const live: string[] = [];
  const dropped: string[] = [];
  for (const b of branches) {
    if ((await git.tryRun(["rev-parse", "--verify", "--quiet", b])).code !== 0) { dropped.push(`${b} (missing)`); continue; }
    if ((await git.tryRun(["merge-base", "--is-ancestor", b, mainBranch])).code === 0) { dropped.push(`${b} (already in ${mainBranch})`); continue; }
    live.push(b);
  }
  if (dropped.length) console.log(`skipping ${dropped.length}: ${dropped.join(", ")}`);
  branches = live;
  if (branches.length === 0) {
    console.log(`nothing to integrate — all completed branches already landed in ${mainBranch}`);
    return;
  }

  const testCommand = str(f, "test") || undefined;
  const cfg = await loadConfig(repo);
  const resolver = new ClaudeConflictResolver({
    bin: str(f, "agent-bin") || undefined,
    args: [...agentArgs(f), ...roleArgs(cfg, "negotiator")],
  });
  const negotiator = new Negotiator({
    resolvers: [resolver],
    tieBreaker: resolver,
    maxRounds: num(f, "max-rounds", 3),
    logger: (m) => console.log(m),
  });

  const targetIsNew = (await git.tryRun(["rev-parse", "--verify", "--quiet", mainBranch])).code !== 0;
  console.log(
    `integrating into ${mainBranch}${targetIsNew ? ` (new branch off ${trunk})` : ""}: ${branches.join(", ")}`,
  );
  const result = await new Integrator({
    repoRoot: repo,
    mainBranch,
    baseBranch: trunk,
    testCommand,
    negotiator,
    continueOnUnresolved: prioritized,
    events: logEvents(),
    logger: (m) => console.log(m),
  }).integrate(branches);

  console.log(`\nintegration ${result.promoted ? `PROMOTED to ${mainBranch}` : "did NOT promote"}`);
  for (const s of result.steps) console.log(`  ${s.branch}: ${s.status}${s.detail ? " — " + s.detail : ""}`);
  if (result.warning) console.log(`\n⚠ ${result.warning}`);
  if (!result.promoted) process.exitCode = 1;
}

async function cmdStatus(f: Flags): Promise<void> {
  const repo = path.resolve(str(f, "repo", process.cwd()));
  const status = await readFleetStatus(repo);
  if (f.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log(`harness status — ${repo}\n`);
  console.log("workers:");
  for (const w of status.workers) {
    console.log(`  ${w.state.padEnd(10)} ${w.branch.padEnd(24)} ${(w.head ?? "").slice(0, 8)}`);
  }
  if (!status.workers.length) console.log("  (none)");
  if (status.integration) {
    console.log(`\nintegration: ${status.integration.promoted ? "promoted" : "not promoted"} @ ${(status.integration.mainHead ?? "").slice(0, 8)}`);
    for (const s of status.integration.steps) console.log(`  ${s.branch}: ${s.status}`);
  }
  console.log(`\ncheckpoints: ${status.checkpoints.length} · live worktrees: ${status.worktrees.length}`);
}

async function cmdInject(f: Flags): Promise<void> {
  const repo = path.resolve(str(f, "repo", process.cwd()));
  const branch = str(f, "branch");
  const text = str(f, "text") || (f._ as string[]).slice(1).join(" ");
  if (!branch || !text) throw new Error('usage: harness inject --branch <branch> --text "message"');
  await new InboxManager(repo).post(branch, { kind: "inject", text, from: "cli" });
  console.log(`injected to ${branch}`);
}

async function cmdControl(action: "pause" | "resume" | "end", f: Flags): Promise<void> {
  const repo = path.resolve(str(f, "repo", process.cwd()));
  const branch = str(f, "branch") || (f._ as string[])[1] || "";
  if (!branch) throw new Error(`usage: harness ${action} --branch <branch>`);
  await new InboxManager(repo).post(branch, { kind: action, from: "cli" });
  console.log(`${action} → ${branch}`);
}

async function cmdServe(f: Flags): Promise<void> {
  const repo = path.resolve(str(f, "repo", process.cwd()));
  startServer({ repoRoot: repo, port: num(f, "port", 4317) });
  await new Promise(() => {}); // run forever
}

function logEvents(): HarnessEvents {
  const ev = new HarnessEvents();
  ev.onEvent((e) => {
    if (e.type === "escalate") console.log(`  ⚠ escalate ${e.branch} (${e.kind}): ${e.detail}`);
    if (e.type === "agent:offtrack") console.log(`  ⚠ off-track ${e.branch}: ${e.detail}`);
    if (e.type === "negotiate:round") console.log(`  ↻ ${e.tieBreak ? "tie-break" : "round " + e.round} on ${e.branch} (${e.resolver})`);
  });
  return ev;
}

async function main(): Promise<void> {
  const f = parseArgs(process.argv.slice(2));
  const cmd = (f._ as string[])[0];
  switch (cmd) {
    case "run": return cmdRun(f);
    case "plan": return cmdPlan(f);
    case "integrate": return cmdIntegrate(f);
    case "status": return cmdStatus(f);
    case "serve": return cmdServe(f);
    case "inject": return cmdInject(f);
    case "pause": return cmdControl("pause", f);
    case "resume": return cmdControl("resume", f);
    case "end": return cmdControl("end", f);
    default:
      console.log(`harness — parallel multi-agent branch orchestration

usage:
  harness run <tasks.json> [--repo .] [--concurrency 4] [--base REF] [--agent-bin claude] [--interactive] [--dangerous]
  harness plan <request.json> [--repo .] [--concurrency 4] [--interactive] [--dangerous]
       request.json: { "description", "branch"?, "mode"? (single|auto|split), "continueFrom"?, "targetBranch"? }
  harness integrate [--branches a,b] [--prioritized] [--test "npm test"] [--into BRANCH] [--max-rounds 3] [--repo .] [--dangerous]
       --into: branch to merge the fleet into (created off the trunk if new); default = session target, else main/master
  harness status [--repo .] [--json]
  harness serve [--repo .] [--port 4317]
  harness inject --branch <b> --text "message"     # steer one running agent (interactive mode)
  harness pause|resume|end --branch <b>             # control one running agent

tasks.json: { "tasks": [ { "id", "branch", "description", "blockedBy"? } ], "concurrency"?: 4 }`);
      if (cmd) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("error:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
