import { EventEmitter } from "node:events";

/** Everything observable about a fleet run, for logs and the live UI. */
export type HarnessEvent =
  | { type: "task:start"; taskId: string; branch: string }
  | { type: "task:done"; taskId: string; branch: string; head: string }
  | { type: "task:fail"; taskId: string; branch: string; error: string }
  | { type: "integrate:start"; branches: string[] }
  | { type: "integrate:step"; branch: string; status: string; detail?: string }
  | { type: "integrate:done"; promoted: boolean; mainHead?: string }
  | { type: "negotiate:round"; branch: string; round: number; resolver: string; tieBreak: boolean }
  | { type: "escalate"; branch: string; kind: "textual" | "semantic"; detail: string };

/** Thin typed wrapper over EventEmitter — `onEvent` for everything, plus per-type. */
export class HarnessEvents extends EventEmitter {
  emitEvent(e: HarnessEvent): void {
    this.emit("event", e);
    this.emit(e.type, e);
  }

  onEvent(fn: (e: HarnessEvent) => void): () => void {
    this.on("event", fn);
    return () => this.off("event", fn);
  }
}
