# hydra — parallel multi-agent branch orchestration

A single orchestrator ("Main Agent") fans out N worker agents, each developing
its own branch in an isolated git worktree, then integrates their branches into
`main` with **test-verified** conflict resolution and human escalation only when
needed. The workers are real headless Claude Code agents; hydra launches them,
keeps them isolated, and merges their work back.

- [Requirements](#requirements)
- [Install](#install)
- [Quickstart](#quickstart)
- [How it works](#how-it-works)
- [CLI](#cli)
- [Dashboard](#dashboard)
- [Claude Code skill](#claude-code-skill)
- [Library API](#library-api-advanced)
- [Project layout](#project-layout)
- [Develop](#develop)

## Requirements

- **Node.js ≥ 18** (ESM; hydra runs its TypeScript via `tsx`, no build step needed for dev).
- **git ≥ 2.38** — the integrator uses `git merge-tree --write-tree` for conflict detection.
- **The Claude Code CLI, installed and authenticated.** Each worker is a real
  `claude` process that hydra spawns on your machine, inheriting your login — so
  you must be able to run `claude` in a terminal first. Every worker (and the
  planner/negotiator agents) is a live Claude Code session **billed to your
  account**; a fleet of 4 workers is 4 concurrent sessions. Verify with:
  ```bash
  claude --version    # hydra shells out to this binary
  ```
  Only the library `ScriptWorkerRunner` (used in tests) runs without `claude`.

## Install

hydra is a tool you clone **once** and point at other repos — you do **not** copy
it into each project.

```bash
git clone https://github.com/willqyu/hydra.git
cd hydra
npm install

# optional: compile to dist/ and expose a global `hydra` bin
npm run build      # then `hydra <args>` works anywhere, in place of `npm run hydra --`
```

In development (no build) every command is `npm run hydra -- <args>`, which runs
`node --import tsx src/cli.ts`. The examples below use that form.

## Quickstart

You run hydra **against a target repo** via `--repo <path>`; it creates a
`.hydra/` working dir inside that repo for worktrees, checkpoints, and state
(add `.hydra/` to the target repo's `.gitignore`).

**1. Describe the work as a task DAG** — `tasks.json`:

```json
{
  "concurrency": 3,
  "tasks": [
    { "id": "api",    "branch": "feat/users-api",  "description": "Add POST /users returning 201 with the created user" },
    { "id": "schema", "branch": "feat/user-schema", "description": "Define the User schema and migration" },
    { "id": "wire",   "branch": "feat/wire",        "description": "Wire the API handler to the schema", "blockedBy": ["api", "schema"] }
  ]
}
```

Put a real dependency in `blockedBy`; independent tasks (no deps) run
concurrently. See `examples/tasks.example.json`.

**2. (optional) Bring up the dashboard** to watch it live, then leave it running:

```bash
npm run hydra -- serve --repo /path/to/your/repo     # http://127.0.0.1:4317
```

**3. Fan out the fleet** — one worker per task, each on its own branch/worktree:

```bash
npm run hydra -- run tasks.json --repo /path/to/your/repo --concurrency 3
```

Workers run with `acceptEdits` by default; add `--dangerous` for fully
autonomous agents (`--dangerously-skip-permissions`), or `--interactive` to keep
each agent long-lived and steerable (see [CLI](#cli)).

**4. Integrate** — merge-train the completed branches onto the trunk, gated on tests:

```bash
npm run hydra -- integrate --repo /path/to/your/repo --test "npm test" --max-rounds 3
```

It merges branches one at a time onto a staging branch, runs `--test` after each
merge, negotiates any conflict, and **fast-forwards `main` only when the whole
train is green** — otherwise it escalates and leaves `main` untouched.

## How it works

End-to-end (M1–M5) plus a CLI, a Claude Code skill, and a live dashboard.

- **M1 fan-out + DAG** — schedule a dependency DAG to per-branch worktrees under
  a concurrency cap; a guard keeps each agent's commits inside its own worktree.
- **M2 integration pipeline** — `git merge-tree` conflict detection, serialized
  merge-train onto a staging branch, test gate after each merge, fast-forward
  `main` only when green.
- **M3 negotiation** — intra-fleet bus + bounded-round, test-verified conflict
  resolution (a fix lands only when conflict markers are gone **and** tests pass).
- **M4 semantic conflicts + checkpoint/rehydrate** — a clean merge that breaks
  the test gate is fixed via the semantic path; idle workers despawn and are
  rehydrated from durable checkpoints.
- **M5 escalation + observability** — bounded rounds → orchestrator tie-break →
  human escalation; typed event stream + persisted integration state.

An optional **supervisor** agent can plan the split for you: give it one
description and it decides single-worker-vs-fleet and decomposes into low-overlap,
prioritized branches (see `hydra plan` / the dashboard's Spawn box).

## CLI

```bash
npm run hydra -- run <tasks.json> --repo <target> [--concurrency 3] [--base REF] [--interactive] [--dangerous]
npm run hydra -- plan <request.json> --repo <target> [--interactive] [--dangerous]   # supervisor plans single-vs-fleet
npm run hydra -- integrate --repo <target> [--test "npm test"] [--into BRANCH] [--max-rounds 3] [--prioritized]
npm run hydra -- status --repo <target> [--json]
npm run hydra -- serve  --repo <target> [--port 4317]        # dashboard
# steer a single running agent (interactive mode):
npm run hydra -- inject --repo <target> --branch feat/x --text "focus on error handling"
npm run hydra -- pause|resume|end --repo <target> --branch feat/x
```

- `tasks.json`: `{ "concurrency": 3, "tasks": [ { "id", "branch", "description", "blockedBy"? } ] }`
  (see `examples/tasks.example.json`).
- `request.json` (for `plan`): `{ "description", "branch"?, "mode"? (single|auto|split), "continueFrom"?, "targetBranch"? }`.
- After `npm run build`, the `hydra` bin (`dist/cli.js`) is available directly, so
  `hydra run …` works in place of `npm run hydra -- run …`.

## Dashboard

`hydra serve` starts a dependency-free web UI (default
http://127.0.0.1:4317) that polls `/api/status` every 2s and shows workers,
worktrees, checkpoints, live per-agent transcripts, and integration status. It
also has a **Spawn** box (describe a task → the supervisor plans it) and
Integrate controls. In **interactive mode** each running worker gets a steer box
— type a message to one agent (or Pause/Resume it) while its siblings keep
running.

There is **no hydra daemon**: `run` and `integrate` are one-shot processes over
`<repo>/.hydra`; the dashboard is a separate, optional viewer/controller over
that same state. Each dashboard is pinned to **one repo and one port** — to watch
a second repo, start another `serve` with a different `--port`.

### Fleet hydra 🐉

The dashboard also grows a **hydra** — one pixel-art head per worker, each vibing
with its agent's state: `busy` while working, `sleepy` when idle, `panic` on
failure, and a `disco` + fireworks party when a task lands. Drag a head and its
neck stretches like an elastic band (stressed face and a startled `!` included);
let go and it springs back. Click a head to make it jump, or bop the body to hop
the whole fleet. A spawning worker's head grows out of the body; once a branch
merges into `main` it folds in with a puff of smoke. When a branch hits a
conflict during integration, the heads of the branches being reconciled
**tangle** together — they huddle onto a shared knot and their necks braid and
strain — then spring apart once the negotiation resolves or escalates. (The
integrator persists a transient `negotiating` step while the bounded rounds run,
so the dashboard poll catches the tangle live.) Served at `/hydra.html` — drive
it via `window.hydra` (`setTangle([i,…])`) or the postMessage bridge;
`?showcase` parades every mode at once, `?tangle=0,2,3` previews a knot. A
self-driving `/demo` mode renders the whole dashboard against a fabricated fleet
with no backend.

## Claude Code skill

`skills/orchestrate/SKILL.md` lets Claude Code drive all of the above from a
normal chat — you say "parallelize this across agents" and Claude runs the hydra
CLI for you.

**Prerequisites:** hydra cloned + `npm install`ed (above), and the `claude` CLI
authenticated. **Install** the skill by symlinking it into your Claude Code
skills dir (run from the repo root, or replace `$PWD` with the path to your clone):

```bash
ln -s "$PWD/skills/orchestrate" ~/.claude/skills/orchestrate
```

Then, in a Claude Code session on any repo, ask it to "orchestrate" /
"parallelize across branches" / "run agents in parallel" and it will decompose
the work into a task DAG and drive `hydra run` / `hydra integrate`.

## Library API (advanced)

hydra is also a library — inject your own `WorkerRunner`:

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

`ScriptWorkerRunner` runs a plain JS function (used by the tests).
`ClaudeAgentRunner` is the real worker — it spawns a headless `claude` agent in
each worktree; `StreamingClaudeAgentRunner` is its long-lived, steerable variant
(`run --interactive`). Public exports live in `src/index.ts`.

## Project layout

```
src/
  # orchestration core
  orchestrator.ts     scheduling loop: DAG + concurrency -> per-branch worktrees
  task-dag.ts         dependency graph: validation, cycle detection, ready-set
  worktree.ts         git worktree create/remove/list (per-branch isolation)
  worktree-guard.ts   keeps each agent's commits inside its own worktree
  worker.ts           ScriptWorkerRunner + ClaudeAgentRunner (headless)
  streaming-worker.ts StreamingClaudeAgentRunner (long-lived, steerable)
  claude.ts           spawn the local `claude` CLI
  supervisor.ts       planner agent: single-vs-fleet + branch decomposition
  # integration
  integrator.ts       serialized merge-train + per-merge test gate
  negotiator.ts       bounded-round, test-verified conflict resolution
  claude-resolver.ts  Claude-backed conflict resolver
  # state & messaging
  registry.ts         deterministic branch -> worker map, persisted to disk
  checkpoint.ts       durable per-worker checkpoints (despawn/rehydrate)
  inbox.ts            per-branch steering channel (.hydra/inbox/<branch>.jsonl)
  session.ts          per-repo session (active integration target)
  events.ts           typed event bus for logs + the dashboard
  # interfaces
  cli.ts              CLI entry point
  server.ts           dependency-free dashboard HTTP server
  status.ts           aggregated FleetStatus for the dashboard
  transcript.ts       tail agent transcripts from ~/.claude/projects
  branches.ts         per-branch commit history for the UI
  config.ts           per-role prompts/models (editable in Settings)
  index.ts            public library exports
web/                  dashboard pages (index, hydra, settings, branches, demo) + sounds
skills/orchestrate/   the Claude Code skill (SKILL.md)
test/                 end-to-end + unit tests (m1–m5, integrator, negotiator, registry, worktree, …)
examples/             tasks.example.json
```

## Develop

```bash
npm install
npm run typecheck
npm test
npm run build      # emit dist/ (and the hydra bin)
```
