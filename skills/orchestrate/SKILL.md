---
name: orchestrate
description: >-
  Fan a piece of work out across multiple Claude Code worker agents, each on its
  own branch in an isolated git worktree, then integrate the branches into main
  with test-verified, automatically-negotiated conflict resolution. Use when a
  task naturally splits into 2+ parallel branches, when the user asks to
  "parallelize", "run agents in parallel", "split this across branches", or to
  build/monitor a fleet of worker agents.
---

# orchestrate — parallel multi-agent branch orchestration

This skill drives the `hydra` tool (an orchestrator + integration pipeline).
The orchestrator fans tasks out to worker agents on separate worktrees,
checkpoints their state, and a merge-train integrates the branches into `main` —
serializing merges, running a test gate after each, and negotiating conflicts
(textual *and* semantic) before promoting `main`.

`hydra` lives at `C:\code\hydra` (run via `npm run hydra -- <args>`
there, or `node --import tsx C:\code\hydra\src\cli.ts <args>`).

## When to use vs. not

- **Use** when the work splits into 2+ branches that can progress independently,
  or the user explicitly wants parallel agents / a fleet.
- **Don't** use for a single linear change — just do it directly. Orchestration
  overhead only pays off across multiple branches.

## Workflow

### 1. Decompose into a task DAG

Break the request into discrete tasks. For each: a short `id`, a `branch` name,
a self-contained `description` (the brief the worker agent receives), and
`blockedBy` for any task that depends on another's output.

**Critical:** put a real dependency in `blockedBy` rather than running dependent
work in parallel. Racing genuinely-sequential work manufactures the very merge
conflicts you'd then have to resolve. Independent work → no deps → runs
concurrently.

Write it to a tasks file, e.g. `tasks.json`:

```json
{
  "concurrency": 3,
  "tasks": [
    { "id": "api",    "branch": "feat/users-api",   "description": "Add POST /users …" },
    { "id": "schema", "branch": "feat/user-schema",  "description": "Define User schema …" },
    { "id": "wire",   "branch": "feat/wire",         "description": "Wire API to schema …", "blockedBy": ["api", "schema"] }
  ]
}
```

See `C:\code\hydra\examples\tasks.example.json`.

### 2. Run the fleet

```
npm run hydra -- run tasks.json --repo <target-repo> --concurrency 3
```

Each task gets a worktree + branch; a Claude Code agent implements it and
commits **incrementally** (the worker brief instructs agents to commit after each
logical step, not only at the end). Add `--dangerous` for fully autonomous agents
(`--dangerously-skip-permissions`); otherwise agents run with `acceptEdits`.
Completed workers are checkpointed under `<repo>/.hydra/checkpoints`.

Add `--interactive` to keep each agent long-lived and steerable (see step 3b).

### 3. Integrate into main

```
npm run hydra -- integrate --repo <target-repo> --test "npm test" --max-rounds 3
```

With no `--branches`, it integrates all completed branches from the registry.
The pipeline merges them one at a time onto a staging branch, runs `--test`
after each merge (this is what catches *semantic* conflicts that merge cleanly
but break the build), negotiates any conflict via agent resolvers with a
bounded round count, falls back to a tie-break, and **only fast-forwards `main`
when the whole train is green**. If it can't resolve, it escalates and leaves
`main` untouched — surface that to the user.

### 3b. Steer a single agent (interactive mode)

When you ran with `--interactive`, you can talk to one agent while the others
keep working — useful to correct course or add a constraint without restarting:

```
npm run hydra -- inject --repo <target> --branch feat/users-api --text "reuse the existing validator in lib/validate"
npm run hydra -- pause  --repo <target> --branch feat/users-api      # buffer further messages
npm run hydra -- resume --repo <target> --branch feat/users-api      # flush them
npm run hydra -- end    --repo <target> --branch feat/users-api      # tell the agent to wrap up
```

The dashboard exposes the same controls (a steer box + Pause/Resume per running
agent). Messages route only to the addressed branch's agent.

### 4. Monitor (optional)

```
npm run hydra -- serve --repo <target-repo> --port 4317
```

Opens a dashboard at http://127.0.0.1:4317 showing workers, worktrees,
checkpoints, and integration status (polls every 2s). Or one-shot:

```
npm run hydra -- status --repo <target-repo> --json
```

## Reporting back

Tell the user: which branches landed on `main`, which were resolved via
negotiation (and how — round vs. tie-break), and anything that **escalated**
(needs human judgement). Never claim `main` was promoted unless `integrate`
reported `PROMOTED`.

## Notes

- Requires git ≥ 2.38 (uses `git merge-tree --write-tree`) and Node ≥ 18.
- Conflict resolution is test-verified: a resolution is accepted only when
  conflict markers are gone AND the test gate passes. No test command means only
  textual conflicts are gated.
- "Live until merged" is implemented as durable checkpoints, not hot processes:
  idle workers despawn and are rehydrated from their checkpoint if a late
  conflict needs them.
