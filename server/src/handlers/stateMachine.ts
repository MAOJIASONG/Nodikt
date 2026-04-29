import {
  Demand,
  DemandState,
  Execution,
  ExecutionState,
  SubgoalContract,
  SubgoalState,
  nowIso
} from "../domain/index.js";
import { RuntimeSessionPatch, patchRuntimeSession } from "./sessionState.js";

export const ACTIVE_EXECUTION_STATES = new Set([
  ExecutionState.QUEUED,
  ExecutionState.RUNNING,
  ExecutionState.VERIFYING
]);

export const DEMAND_TRANSITIONS: Record<DemandState, DemandState[]> = {
  [DemandState.PENDING_ALIGNMENT]: [
    DemandState.PENDING_ALIGNMENT,
    DemandState.READY,
    DemandState.PAUSED,
    DemandState.CANCELLED
  ],
  [DemandState.READY]: [
    DemandState.READY,
    DemandState.ACTIVE,
    DemandState.PENDING_DECISION,
    DemandState.PAUSED,
    DemandState.CANCELLED
  ],
  [DemandState.ACTIVE]: [
    DemandState.ACTIVE,
    DemandState.READY,
    DemandState.PENDING_DECISION,
    DemandState.PAUSED,
    DemandState.COMPLETED,
    DemandState.FAILED,
    DemandState.CANCELLED
  ],
  [DemandState.PENDING_DECISION]: [
    DemandState.PENDING_DECISION,
    DemandState.READY,
    DemandState.ACTIVE,
    DemandState.PAUSED,
    DemandState.COMPLETED,
    DemandState.CANCELLED
  ],
  [DemandState.PAUSED]: [
    DemandState.PAUSED,
    DemandState.READY,
    DemandState.ACTIVE,
    DemandState.CANCELLED
  ],
  [DemandState.COMPLETED]: [DemandState.COMPLETED],
  [DemandState.FAILED]: [DemandState.FAILED],
  [DemandState.CANCELLED]: [DemandState.CANCELLED]
};

export const SUBGOAL_TRANSITIONS: Record<SubgoalState, SubgoalState[]> = {
  [SubgoalState.PLANNED]: [
    SubgoalState.PLANNED,
    SubgoalState.READY,
    SubgoalState.CANCELLED
  ],
  [SubgoalState.READY]: [
    SubgoalState.READY,
    SubgoalState.DISPATCHED,
    SubgoalState.BLOCKED,
    SubgoalState.CANCELLED
  ],
  [SubgoalState.DISPATCHED]: [
    SubgoalState.DISPATCHED,
    SubgoalState.EXECUTING,
    SubgoalState.BLOCKED,
    SubgoalState.CANCELLED
  ],
  [SubgoalState.EXECUTING]: [
    SubgoalState.EXECUTING,
    SubgoalState.VERIFYING,
    SubgoalState.BLOCKED,
    SubgoalState.FAILED,
    SubgoalState.CANCELLED
  ],
  [SubgoalState.BLOCKED]: [
    SubgoalState.BLOCKED,
    SubgoalState.READY,
    SubgoalState.FAILED,
    SubgoalState.CANCELLED
  ],
  [SubgoalState.VERIFYING]: [
    SubgoalState.VERIFYING,
    SubgoalState.READY,
    SubgoalState.DONE,
    SubgoalState.BLOCKED,
    SubgoalState.FAILED,
    SubgoalState.CANCELLED
  ],
  [SubgoalState.DONE]: [SubgoalState.DONE],
  [SubgoalState.FAILED]: [SubgoalState.FAILED],
  [SubgoalState.CANCELLED]: [SubgoalState.CANCELLED]
};

export const EXECUTION_TRANSITIONS: Record<ExecutionState, ExecutionState[]> = {
  [ExecutionState.QUEUED]: [
    ExecutionState.QUEUED,
    ExecutionState.RUNNING,
    ExecutionState.INTERRUPTED,
    ExecutionState.TIMEOUT,
    ExecutionState.CANCELLED
  ],
  [ExecutionState.RUNNING]: [
    ExecutionState.RUNNING,
    ExecutionState.WAITING_RESULT,
    ExecutionState.VERIFYING,
    ExecutionState.FAILED,
    ExecutionState.INTERRUPTED,
    ExecutionState.TIMEOUT,
    ExecutionState.CANCELLED
  ],
  [ExecutionState.WAITING_RESULT]: [
    ExecutionState.WAITING_RESULT,
    ExecutionState.VERIFYING,
    ExecutionState.FAILED,
    ExecutionState.INTERRUPTED,
    ExecutionState.TIMEOUT,
    ExecutionState.CANCELLED
  ],
  [ExecutionState.VERIFYING]: [
    ExecutionState.VERIFYING,
    ExecutionState.DONE,
    ExecutionState.FAILED,
    ExecutionState.INTERRUPTED,
    ExecutionState.TIMEOUT,
    ExecutionState.CANCELLED
  ],
  [ExecutionState.DONE]: [ExecutionState.DONE],
  [ExecutionState.FAILED]: [ExecutionState.FAILED],
  [ExecutionState.INTERRUPTED]: [ExecutionState.INTERRUPTED],
  [ExecutionState.TIMEOUT]: [ExecutionState.TIMEOUT],
  [ExecutionState.CANCELLED]: [ExecutionState.CANCELLED]
};

export type DemandSnapshotPatch = Partial<Omit<Demand, "demand_id" | "created_at">>;
export type SubgoalSnapshotPatch = Partial<Omit<SubgoalContract, "subgoal_id" | "demand_id" | "created_at">>;
export type ExecutionSnapshotPatch = Partial<Omit<Execution, "execution_id" | "demand_id" | "subgoal_id" | "worker_id" | "created_at">>;

export function assertTransition<TState extends string>(
  label: string,
  current: TState,
  next: TState,
  transitions: Record<TState, TState[]>
): void {
  if (!transitions[current]?.includes(next)) {
    throw new Error(`Illegal ${label} transition: ${current} -> ${next}`);
  }
}

export function transitionDemand(
  demand: Demand,
  patch: DemandSnapshotPatch,
  sessionPatch: RuntimeSessionPatch = {}
): Demand {
  const timestamp = nowIso();
  const nextState = patch.state ?? demand.state;
  assertTransition("demand", demand.state, nextState, DEMAND_TRANSITIONS);
  const nextPhase = patch.current_phase ?? sessionPatch.phase ?? demand.current_phase;

  return {
    ...demand,
    ...patch,
    state: nextState,
    current_phase: nextPhase,
    metadata: patchRuntimeSession(
      patch.metadata ?? demand.metadata,
      {
        phase: nextPhase,
        ...sessionPatch
      },
      timestamp
    ),
    updated_at: timestamp
  };
}

export function transitionSubgoal(
  subgoal: SubgoalContract,
  patch: SubgoalSnapshotPatch
): SubgoalContract {
  const nextState = patch.state ?? subgoal.state;
  assertTransition("subgoal", subgoal.state, nextState, SUBGOAL_TRANSITIONS);
  return {
    ...subgoal,
    ...patch,
    state: nextState,
    updated_at: nowIso()
  };
}

export function transitionExecution(
  execution: Execution,
  patch: ExecutionSnapshotPatch
): Execution {
  const nextState = patch.state ?? execution.state;
  assertTransition("execution", execution.state, nextState, EXECUTION_TRANSITIONS);
  return {
    ...execution,
    ...patch,
    state: nextState,
    updated_at: nowIso()
  };
}

export function isTerminalDemand(demand: Demand): boolean {
  return [
    DemandState.COMPLETED,
    DemandState.FAILED,
    DemandState.CANCELLED
  ].includes(demand.state);
}
