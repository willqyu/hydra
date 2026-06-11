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
  /** Integration priority (1 = highest); set when a supervisor planned a fleet. */
  priority?: number;
  updatedAt: string;
}

/**
 * Deterministic branch -> worker map, persisted to disk. Replaces peerd's
 * "newest opted-in session" routing, which is wrong for orchestrated fan-out:
 * the orchestrator must address "the worker holding branch B" precisely.
 */
export class Registry {
  private readonly entries = new Map<string, RegistryEntry>();
  /** Branches explicitly removed by this process — never re-add them on flush. */
  private readonly removed = new Set<string>();

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

  /** Drop a branch's entry (e.g. after deleting an invalid branch). */
  async remove(branch: string): Promise<boolean> {
    const had = this.entries.delete(branch);
    this.removed.add(branch); // tombstone so the merge-flush won't resurrect it
    await this.flush();
    return had;
  }

  private async flush(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    // Merge with the on-disk state before writing. Each harness process holds its
    // own in-memory copy of the registry; a blind whole-file overwrite would drop
    // entries a *concurrent* process wrote since we opened (the cause of workers
    // vanishing from the dashboard). We keep our own entries authoritative for the
    // branches we own, and preserve any branch we don't know about.
    try {
      const disk = JSON.parse(await readFile(this.file, "utf8")) as RegistryEntry[];
      for (const e of disk) {
        if (!this.entries.has(e.branch) && !this.removed.has(e.branch)) this.entries.set(e.branch, e);
      }
    } catch {
      // No file yet, or unreadable — just write our own state.
    }
    await writeFile(this.file, JSON.stringify(this.all(), null, 2), "utf8");
  }
}
