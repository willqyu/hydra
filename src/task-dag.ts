import type { TaskId, TaskSpec, TaskState } from "./types.js";

export interface TaskNode extends TaskSpec {
  blockedBy: TaskId[];
  state: TaskState;
}

/**
 * Dependency graph of tasks. Validates at construction (unknown deps, self-deps,
 * duplicate ids/branches, cycles) so genuinely-sequential work is never raced —
 * the core defense against manufacturing merge conflicts.
 */
export class TaskDag {
  private readonly nodes = new Map<TaskId, TaskNode>();

  constructor(specs: TaskSpec[]) {
    for (const s of specs) {
      if (this.nodes.has(s.id)) throw new Error(`duplicate task id: ${s.id}`);
      this.nodes.set(s.id, { ...s, blockedBy: s.blockedBy ?? [], state: "pending" });
    }
    this.validate();
  }

  private validate(): void {
    const branches = new Set<string>();
    for (const n of this.nodes.values()) {
      if (branches.has(n.branch)) throw new Error(`duplicate branch: ${n.branch}`);
      branches.add(n.branch);
      for (const dep of n.blockedBy) {
        if (dep === n.id) throw new Error(`task ${n.id} cannot block itself`);
        if (!this.nodes.has(dep)) throw new Error(`task ${n.id} blocked by unknown task ${dep}`);
      }
    }
    this.detectCycles();
  }

  private detectCycles(): void {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<TaskId, number>();
    for (const id of this.nodes.keys()) color.set(id, WHITE);
    const visit = (id: TaskId, stack: TaskId[]): void => {
      color.set(id, GRAY);
      for (const dep of this.nodes.get(id)!.blockedBy) {
        if (color.get(dep) === GRAY) {
          throw new Error(`dependency cycle: ${[...stack, id, dep].join(" -> ")}`);
        }
        if (color.get(dep) === WHITE) visit(dep, [...stack, id]);
      }
      color.set(id, BLACK);
    };
    for (const id of this.nodes.keys()) if (color.get(id) === WHITE) visit(id, []);
  }

  get(id: TaskId): TaskNode {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`unknown task: ${id}`);
    return n;
  }

  all(): TaskNode[] {
    return [...this.nodes.values()];
  }

  setState(id: TaskId, state: TaskState): void {
    this.get(id).state = state;
  }

  /** Pending tasks whose dependencies have all completed. */
  ready(): TaskNode[] {
    return this.all().filter(
      (n) => n.state === "pending" && n.blockedBy.every((dep) => this.get(dep).state === "completed"),
    );
  }

  /** True once no task is pending or running. */
  done(): boolean {
    return this.all().every((n) => n.state === "completed" || n.state === "failed");
  }
}
