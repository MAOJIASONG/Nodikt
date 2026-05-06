/**
 * 文件名称：stateMachine.ts
 * 文件作用：调度状态机模块，集中定义需求、子目标和执行的合法状态流转。
 *
 * 主要职责：
 * 1. 定义活跃执行状态集合和各实体状态转换表。
 * 2. 校验状态转换是否合法。
 * 3. 生成需求、子目标和执行的状态快照更新。
 * 4. 判断需求是否已进入终态。
 *
 * 依赖模块：
 * - domain：需求、子目标、执行及其状态枚举。
 * - sessionState：运行会话状态补丁工具。
 * - logger：状态机日志。
 *
 * 注意事项：
 * - 状态转换表是调度一致性的核心，新增状态时必须同步测试。
 * - 调用方应通过本模块完成状态变更，避免绕过合法性校验。
 */
import {
  Demand,
  DemandState,
  Execution,
  ExecutionState,
  SubgoalContract,
  SubgoalState,
  nowIso
} from "../../../domain/index.js";
import { createLogger } from "../../../logger.js";
import { RuntimeSessionPatch, patchRuntimeSession } from "./sessionState.js";

const logger = createLogger("handlers:state_machine");

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

/**
 * 函数作用：校验实体状态转换是否合法。
 *
 * 参数说明：
 * - entity：实体名称，用于错误提示。
 * - from：当前状态。
 * - to：目标状态。
 * - transitions：合法状态转换表。
 *
 * 返回值：
 * - void：合法时无返回，非法时抛出错误。
 */
export function assertTransition<TState extends string>(
  label: string,
  current: TState,
  next: TState,
  transitions: Record<TState, TState[]>
): void {
  if (!transitions[current]?.includes(next)) {
    logger.error({ label, current, next }, "检测到非法状态流转");
    throw new Error(`Illegal ${label} transition: ${current} -> ${next}`);
  }
}

/**
 * 函数作用：生成需求状态转换后的新快照。
 *
 * 参数说明：
 * - demand：原需求实体。
 * - nextState：目标需求状态。
 * - patch：可选字段补丁。
 *
 * 返回值：
 * - Demand：更新状态、阶段和时间戳后的需求实体。
 */
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

/**
 * 函数作用：生成子目标状态转换后的新快照。
 *
 * 参数说明：
 * - subgoal：原子目标实体。
 * - nextState：目标子目标状态。
 * - patch：可选字段补丁。
 *
 * 返回值：
 * - SubgoalContract：更新状态和时间戳后的子目标实体。
 */
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

/**
 * 函数作用：生成执行状态转换后的新快照。
 *
 * 参数说明：
 * - execution：原执行实体。
 * - nextState：目标执行状态。
 * - patch：可选字段补丁。
 *
 * 返回值：
 * - Execution：更新状态和时间戳后的执行实体。
 */
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

/**
 * 函数作用：判断需求是否已经进入终态。
 *
 * 参数说明：
 * - demand：待判断的需求实体。
 *
 * 返回值：
 * - boolean：需求完成、取消或失败时返回 true。
 */
export function isTerminalDemand(demand: Demand): boolean {
  return [
    DemandState.COMPLETED,
    DemandState.FAILED,
    DemandState.CANCELLED
  ].includes(demand.state);
}
