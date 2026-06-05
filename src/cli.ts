#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Git } from "./git.js";
import { Orchestrator } from "./orchestrator.js";
import { ClaudeAgentRunner } from "./worker.js";
import { StreamingClaudeAgentRunner } from "./streaming-worker.js";
import { InboxManager } from "./inbox.js";
import { Integrator } from "./integrator.js";
import { Negotiator } from "./negotiator.js";
import { ClaudeConflictResolver } from "./claude-resolver.js";
import { HarnessEvents } from "./events.js";
import { Registry } from "./registry.js";
import { readFleetStatus } from "./status.js";
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

/** Agent CLI args, with --dangerous enabling fully autonomous runs. */
function agentArgs(f: Flags): string[] {
  return f.dangerous
    ? ["-p", "--dangerously-skip-permissions"]
    : ["-p", "--permission-mode", "acceptEdits"];
}

async function cmdRun(f: Flags): Promise<void> {
  const repo = path.resolve(str(f, "repo", process.cwd()));
  const file = (f._ as string[])[1];
  if (!file) throw new Error("usage: harness run <tasks.json> [--repo .] [--concurrency N] [--base REF] [--dangerous]");
  const parsed = JSON.parse(await readFile(path.resolve(file), "utf8"));
  const tasks: TaskSpec[] = Array.isArray(parsed) ? parsed : parsed.tasks;

  const events = logEvents();
  const runner = f.interactive
    ? new StreamingClaudeAgentRunner({
        bin: str(f, "agent-bin") || undefined,
        events,
        logger: (m) => console.log("  " + m),
      })
    : new ClaudeAgentRunner({
        bin: str(f, "agent-bin") || undefined,
        args: agentArgs(f),
        logger: (m) => console.log("  " + m),
      });
  if (f.interactive) console.log("interactive mode — steer agents via `harness inject` or the dashboard");
  const result = await new Orchestrator({
    repoRoot: repo,
    runner,
    concurrency: num(f, "concurrency", parsed.concurrency ?? 4),
    baseRef: str(f, "base") || parsed.baseRef || undefined,
    events,
    logger: (m) => console.log(m),
  }).run(tasks);

  console.log(`\nrun complete: ${result.completed} ok, ${result.failed} failed`);
  if (result.skipped.length) console.log(`skipped (blocked): ${result.skipped.join(", ")}`);
}

async function cmdIntegrate(f: Flags): Promise<void> {
  const repo = path.resolve(str(f, "repo", process.cwd()));
  let branches = str(f, "branches")
    ? str(f, "branches").split(",").map((b) => b.trim()).filter(Boolean)
    : [];
  if (branches.length === 0) {
    const reg = await Registry.open(path.join(repo, ".harness", "registry.json"));
    branches = reg.all().filter((e) => e.state === "completed").map((e) => e.branch);
  }
  if (branches.length === 0) throw new Error("no branches to integrate (pass --branches a,b or run first)");

  const testCommand = str(f, "test") || undefined;
  const resolver = new ClaudeConflictResolver({ bin: str(f, "agent-bin") || undefined, args: agentArgs(f) });
  const negotiator = new Negotiator({
    resolvers: [resolver],
    tieBreaker: resolver,
    maxRounds: num(f, "max-rounds", 3),
    logger: (m) => console.log(m),
  });

  console.log(`integrating: ${branches.join(", ")}`);
  const result = await new Integrator({
    repoRoot: repo,
    mainBranch: str(f, "main") || undefined,
    testCommand,
    negotiator,
    events: logEvents(),
    logger: (m) => console.log(m),
  }).integrate(branches);

  console.log(`\nintegration ${result.promoted ? "PROMOTED to main" : "did NOT promote"}`);
  for (const s of result.steps) console.log(`  ${s.branch}: ${s.status}${s.detail ? " — " + s.detail : ""}`);
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
    if (e.type === "negotiate:round") console.log(`  ↻ ${e.tieBreak ? "tie-break" : "round " + e.round} on ${e.branch} (${e.resolver})`);
  });
  return ev;
}

async function main(): Promise<void> {
  const f = parseArgs(process.argv.slice(2));
  const cmd = (f._ as string[])[0];
  switch (cmd) {
    case "run": return cmdRun(f);
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
  harness integrate [--branches a,b] [--test "npm test"] [--main main] [--max-rounds 3] [--repo .] [--dangerous]
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
