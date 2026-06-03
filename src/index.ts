export { Git } from "./git.js";
export { TaskDag } from "./task-dag.js";
export type { TaskNode } from "./task-dag.js";
export { WorktreeManager } from "./worktree.js";
export type { WorktreeInfo } from "./worktree.js";
export { Registry } from "./registry.js";
export type { RegistryEntry } from "./registry.js";
export { ScriptWorkerRunner, ClaudeAgentRunner } from "./worker.js";
export type { WorkerFn, WorkerFnResult } from "./worker.js";
export { Orchestrator } from "./orchestrator.js";
export type { OrchestratorOptions, TaskOutcome, RunResult } from "./orchestrator.js";
export { MergeTool } from "./merge.js";
export type { ConflictReport } from "./merge.js";
export { execShell } from "./exec.js";
export type { ExecResult } from "./exec.js";
export { Integrator } from "./integrator.js";
export type {
  IntegratorOptions,
  IntegrationResult,
  IntegrationStep,
  StepStatus,
  Negotiator as NegotiatorInterface,
  ConflictResolution,
  TextualConflictInput,
  SemanticConflictInput,
} from "./integrator.js";
export { IntraFleetBus } from "./bus.js";
export type { BusMessage, BusMessageKind } from "./bus.js";
export { ScriptConflictResolver } from "./resolver.js";
export type {
  ConflictResolver,
  ConflictFile,
  ResolutionRequest,
  ResolutionProposal,
} from "./resolver.js";
export { Negotiator } from "./negotiator.js";
export type { NegotiatorOptions } from "./negotiator.js";
export { CheckpointManager } from "./checkpoint.js";
export type { Checkpoint } from "./checkpoint.js";
export { HarnessEvents } from "./events.js";
export type { HarnessEvent } from "./events.js";
export type {
  TaskId,
  TaskSpec,
  TaskState,
  WorkerContext,
  WorkerResult,
  WorkerRunner,
} from "./types.js";
