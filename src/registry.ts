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
  /** Branch this task should be integrated into (default trunk). Set when the task
   *  was spawned with an active session target; drives the Integrate default. */
  targetBranch?: string;
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
  /** Branches THIS instance has actually written — the only ones whose in-memory
   *  value overrides disk on flush. Everything else reflects the latest disk
   *  state, so a long-lived reader (e.g. the dashboard's 2s status poll) can't
   *  clobber a concurrent writer's — or a manual repair's — change to a branch it
   *  merely loaded but never touched. */
  private readonly dirty = new Set<string>();

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
    this.dirty.add(entry.branch);
    await this.flush();
  }

  /** Drop a branch's entry (e.g. after deleting an invalid branch). */
  async remove(branch: string): Promise<boolean> {
    const had = this.entries.delete(branch);
    this.removed.add(branch); // tombstone so the merge-flush won't resurrect it
    this.dirty.delete(branch);
    await this.flush();
    return had;
  }

  private async flush(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    // Start from CURRENT disk state so concurrent writers' changes survive, then
    // impose ONLY what this instance actually changed: dirty entries override,
    // tombstoned removes delete. Branches we merely loaded at open() are left as
    // disk has them — that's what stops the dashboard's status poll from reverting
    // a repair or another process's write to a branch it never touched.
    const merged = new Map<string, RegistryEntry>();
    try {
      const disk = JSON.parse(await readFile(this.file, "utf8")) as RegistryEntry[];
      for (const e of disk) merged.set(e.branch, e);
    } catch {
      // No file yet, or unreadable — start from our own dirty entries alone.
    }
    for (const b of this.dirty) {
      const e = this.entries.get(b);
      if (e) merged.set(b, e);
    }
    for (const b of this.removed) merged.delete(b);

    // Sync our in-memory view to exactly what we're writing.
    this.entries.clear();
    for (const [b, e] of merged) this.entries.set(b, e);
    this.dirty.clear();

    await writeFile(this.file, JSON.stringify([...merged.values()], null, 2), "utf8");
  }
}
