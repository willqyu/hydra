import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { TaskId, TaskState } from "./types.js";

export interface RegistryEntry {
  taskId: TaskId;
  branch: string;
  worktree?: string;
  state: TaskState;
  /** HEAD commit on the branch after the worker ran. */
  head?: string;
  error?: string;
  /** Path to a durable checkpoint snapshot (used for rehydrate in M4). */
  checkpoint?: string;
  updatedAt: string;
}

/**
 * Deterministic branch -> worker map, persisted to disk. Replaces peerd's
 * "newest opted-in session" routing, which is wrong for orchestrated fan-out:
 * the orchestrator must address "the worker holding branch B" precisely.
 */
export class Registry {
  private readonly entries = new Map<string, RegistryEntry>();

  private constructor(private readonly file: string) {}

  static async open(file: string): Promise<Registry> {
    const reg = new Registry(file);
    try {
      const raw = await readFile(file, "utf8");
      for (const e of JSON.parse(raw) as RegistryEntry[]) reg.entries.set(e.branch, e);
    } catch {
      // No file yet — start empty.
    }
    return reg;
  }

  get(branch: string): RegistryEntry | undefined {
    return this.entries.get(branch);
  }

  byTask(taskId: TaskId): RegistryEntry | undefined {
    for (const e of this.entries.values()) if (e.taskId === taskId) return e;
    return undefined;
  }

  all(): RegistryEntry[] {
    return [...this.entries.values()];
  }

  async upsert(entry: Omit<RegistryEntry, "updatedAt">): Promise<void> {
    const prev = this.entries.get(entry.branch);
    this.entries.set(entry.branch, { ...prev, ...entry, updatedAt: new Date().toISOString() });
    await this.flush();
  }

  private async flush(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.all(), null, 2), "utf8");
  }
}
