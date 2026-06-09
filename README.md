# harness — parallel multi-agent branch orchestration

A single orchestrator ("Main Agent") fans out N worker agents, each developing
its own branch in an isolated git worktree, then integrates their branches into
`main` with **test-verified** conflict resolution and human escalation only when
needed.

Design rationale and roadmap: `~/.claude/plans/realistically-we-can-just-merry-newt.md`.

## Status

End-to-end (M1–M5) plus a CLI, a Claude Code skill, and a live dashboard.

- **M1 fan-out + DAG** — schedule a dependency DAG to per-branch worktrees.
- **M2 integration pipeline** — `git merge-tree` conflict detection, serialized
  merge-train onto a staging branch, test gate after each merge, fast-forward
  `main` only when green.
- **M3 negotiation** — intra-fleet bus + bounded-round, test-verified conflict
  resolution.
- **M4 semantic conflicts + checkpoint/rehydrate** — a clean merge that breaks
  the test gate is fixed via the semantic path; idle workers despawn and are
  rehydrated from durable checkpoints.
- **M5 escalation + observability** — bounded rounds → orchestrator tie-break →
  human escalation; typed event stream + persisted integration state.

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

`ClaudeAgentRunner` is the real worker — it spawns a headless `claude` agent
inside each worktree (use it in place of `ScriptWorkerRunner`).

## CLI

```bash
npm run harness -- run tasks.json --repo <target> --concurrency 3 [--interactive] [--dangerous]
npm run harness -- integrate --repo <target> --test "npm test" --max-rounds 3
npm run harness -- status --repo <target> [--json]
npm run harness -- serve  --repo <target> --port 4317   # dashboard
# steer a single running agent (interactive mode):
npm run harness -- inject --repo <target> --branch feat/x --text "focus on error handling"
npm run harness -- pause|resume|end --repo <target> --branch feat/x
```

`tasks.json`: `{ "concurrency": 3, "tasks": [ { "id", "branch", "description", "blockedBy"? } ] }`
(see `examples/tasks.example.json`). After `npm run build`, the `harness` bin
(`dist/cli.js`) is also available.

## Dashboard

`harness serve` starts a dependency-free web UI (default
http://127.0.0.1:4317) that polls `/api/status` every 2s and shows workers,
worktrees, checkpoints, and integration status. In **interactive mode** each
running worker gets a steer box — type a message to one agent (or Pause/Resume
it) while its siblings keep running.

### Fleet hydra 🐉

The dashboard also grows a **hydra** — one pixel-art head per worker, each vibing
with its agent's state: `busy` while working, `sleepy` when idle, `panic` on
failure, and a `disco` + fireworks party when a task lands. Drag a head and its
neck stretches like an elastic band (stressed face and a startled `!` included);
let go and it springs back. Click a head to make it jump, or bop the body to hop
the whole fleet. A spawning worker's head grows out of the body; once a branch
merges into `main` it folds in with a puff of smoke. Served at `/hydra.html` —
drive it via `window.hydra` or the postMessage bridge; `?showcase` parades every
mode at once.

## Per-agent interaction

By default workers are one-shot (`ClaudeAgentRunner`). With `run --interactive`
they use `StreamingClaudeAgentRunner`: a long-lived agent whose stdin stays open.
Each worker has a per-branch **inbox** (`.harness/inbox/<branch>.jsonl`); the
dashboard, the `harness inject/pause/resume/end` commands, and the orchestrator
all post to it, and the runner forwards messages to that one agent mid-run.
`pause` buffers injections, `resume` flushes them, `end` closes stdin to wrap the
agent up. This is the file-based substrate peerd uses, scoped to a single agent.

## Claude Code skill

`skills/orchestrate/SKILL.md` lets Claude Code drive all of the above. Install:

```bash
# symlink (or copy) the skill into your Claude Code skills dir
ln -s /home/will/harness/skills/orchestrate ~/.claude/skills/orchestrate
```

Then ask Claude to "orchestrate" / "parallelize across branches".

## Develop

```bash
npm install
npm run typecheck
npm test
npm run build      # emit dist/ (and the harness bin)
```
