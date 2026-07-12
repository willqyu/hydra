import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { ConflictResolver } from "./resolver.js";

/**
 * Durable snapshot of a worker's state. "Live until merged" means the *state*
 * survives until merged — not that the process stays hot. Idle workers despawn;
 * a fresh agent is rehydrated from this snapshot only when a late conflict needs
 * its branch.
 */
export interface Checkpoint {
  taskId: string;
  branch: string;
  /** Branch head at checkpoint time. */
  head: string;
  /** The task spec, so a rehydrated agent knows what it was building. */
  description: string;
  /** The verbatim original user request this branch's task was derived from,
   *  preserved so the overarching goal survives on the branch's durable record. */
  originalPrompt?: string;
  /** Distilled context the worker handed back (decisions, intent, gotchas). */
  context?: string;
  createdAt: string;
}

export class CheckpointManager {
  constructor(private readonly dir: string) {}

  private fileFor(branch: string): string {
    return path.join(this.dir, branch.replace(/[^a-zA-Z0-9._-]/g, "_") + ".json");
  }

  async save(cp: Omit<Checkpoint, "createdAt">): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const full: Checkpoint = { ...cp, createdAt: new Date().toISOString() };
    const file = this.fileFor(cp.branch);
    await writeFile(file, JSON.stringify(full, null, 2), "utf8");
    return file;
  }

  async load(branch: string): Promise<Checkpoint | undefined> {
    try {
      return JSON.parse(await readFile(this.fileFor(branch), "utf8")) as Checkpoint;
    } catch {
      return undefined;
    }
  }

  /** Delete a branch's checkpoint file, if present. */
  async remove(branch: string): Promise<void> {
    await rm(this.fileFor(branch), { force: true });
  }

  async list(): Promise<Checkpoint[]> {
    try {
      const names = await readdir(this.dir);
      const out: Checkpoint[] = [];
      for (const n of names) {
        if (!n.endsWith(".json")) continue;
        try {
          out.push(JSON.parse(await readFile(path.join(this.dir, n), "utf8")) as Checkpoint);
        } catch {
          // skip corrupt entries
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Rehydrate a despawned worker as a negotiation party, seeded from its
   * checkpoint. `factory` builds the resolver (for the real system it spawns a
   * CC agent with the checkpoint's description + context; tests pass a stub).
   */
  async rehydrate(branch: string, factory: (cp: Checkpoint) => ConflictResolver): Promise<ConflictResolver> {
    const cp = await this.load(branch);
    if (!cp) throw new Error(`no checkpoint for branch ${branch}`);
    return factory(cp);
  }
}
