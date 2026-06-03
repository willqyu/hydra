# harness — parallel multi-agent branch orchestration

A single orchestrator ("Main Agent") fans out N worker agents, each developing
its own branch in an isolated git worktree, then integrates their branches into
`main` with **test-verified** conflict resolution and human escalation only when
needed.

Design rationale and roadmap: `~/.claude/plans/realistically-we-can-just-merry-newt.md`.

## Status

**M1 — fan-out + DAG (done).** The orchestrator schedules tasks from a dependency
DAG, spawns each in its own worktree via a pluggable worker runner, records state
in a branch→worker registry, and produces one branch per task. No integration
into `main` yet (that is M2).

Later milestones: M2 integration pipeline (`git merge-tree` detection, staging
branch + main-lock, build/test gate), M3 sibling negotiation over an intra-fleet
bus, M4 semantic conflicts + checkpoint/rehydrate, M5 escalation + observability.

## Layout

```
src/
  git.ts          # async wrapper around the git CLI
  task-dag.ts     # dependency graph: validation, cycle detection, ready-set
  worktree.ts     # git worktree create/remove/list (per-branch isolation)
  registry.ts     # deterministic branch -> worker map, persisted to disk
  worker.ts       # WorkerRunner: ScriptWorkerRunner (now) + ClaudeAgentRunner (stub)
  orchestrator.ts # scheduling loop: DAG + concurrency -> branches
  index.ts        # public exports
test/
  m1.test.ts      # end-to-end: fan-out, DAG ordering, failure-skip, cycle rejection
```

## Usage

```ts
import { Orchestrator, ScriptWorkerRunner } from "./src/index.js";

const runner = new ScriptWorkerRunner(async (ctx) => {
  // do work inside ctx.worktree on branch ctx.branch, then commit
  await ctx.git.run(["commit", "-am", "done"]);
});

const result = await new Orchestrator({ repoRoot: process.cwd(), runner, concurrency: 4 })
  .run([
    { id: "a", branch: "feat/a", description: "build A" },
    { id: "b", branch: "feat/b", description: "build B" },
    { id: "c", branch: "feat/c", description: "wire A+B", blockedBy: ["a", "b"] },
  ]);
```

The real Claude Code worker (`ClaudeAgentRunner`) replaces `ScriptWorkerRunner`
in a later milestone by spawning a CC agent inside each worktree.

## Develop

```bash
npm install
npm run typecheck
npm test
```
