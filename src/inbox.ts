import { appendFile, readFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";

export type InboxKind = "inject" | "pause" | "resume" | "end";

export interface InboxMessage {
  ts: string;
  kind: InboxKind;
  /** Text for `inject` messages. */
  text?: string;
  /** Who sent it (e.g. "human", "orchestrator"). */
  from?: string;
}

/**
 * Per-agent message inbox — the cross-process channel that lets the dashboard,
 * CLI, or orchestrator steer an individual running worker while its siblings run
 * in parallel. One append-only JSONL file per branch. This is the file-based
 * substrate peerd uses for the same job; here it carries human notes and
 * pause/resume/end control to a single addressed agent.
 */
export class InboxManager {
  readonly dir: string;

  constructor(repoRoot: string, dir?: string) {
    this.dir = dir ?? path.join(repoRoot, ".hydra", "inbox");
  }

  private fileFor(branch: string): string {
    return path.join(this.dir, branch.replace(/[^a-zA-Z0-9._-]/g, "_") + ".jsonl");
  }

  async post(branch: string, msg: Omit<InboxMessage, "ts">): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const line = JSON.stringify({ ...msg, ts: new Date().toISOString() }) + "\n";
    await appendFile(this.fileFor(branch), line, "utf8");
  }

  /** Drop a branch's inbox (called at task start so stale messages don't leak). */
  async clear(branch: string): Promise<void> {
    await rm(this.fileFor(branch), { force: true });
  }

  /**
   * Read messages at or after line `offset`. Returns the new messages and the
   * next offset (total line count), so a poller can advance without re-reading.
   */
  async readFrom(branch: string, offset: number): Promise<{ messages: InboxMessage[]; offset: number }> {
    let content: string;
    try {
      content = await readFile(this.fileFor(branch), "utf8");
    } catch {
      return { messages: [], offset };
    }
    const lines = content.split("\n").filter((l) => l.trim());
    const messages: InboxMessage[] = [];
    for (const line of lines.slice(offset)) {
      try {
        messages.push(JSON.parse(line) as InboxMessage);
      } catch {
        // skip malformed line
      }
    }
    return { messages, offset: lines.length };
  }

  async all(branch: string): Promise<InboxMessage[]> {
    return (await this.readFrom(branch, 0)).messages;
  }

  /** Derived state for observability: paused (last pause not yet resumed) + count. */
  async state(branch: string): Promise<{ paused: boolean; count: number }> {
    const msgs = await this.all(branch);
    let paused = false;
    for (const m of msgs) {
      if (m.kind === "pause") paused = true;
      else if (m.kind === "resume") paused = false;
    }
    return { paused, count: msgs.length };
  }
}
