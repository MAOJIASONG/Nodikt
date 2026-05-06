/**
 * 文件名称：service.ts
 * 文件作用：结果归并服务，负责根据验证结果、执行结果和当前状态决定后续调度走向。
 *
 * 主要职责：
 * 1. 汇总工作器结果和验证结果。
 * 2. 判断执行是否完成、需要重试、需要重规划或需要人工决策。
 * 3. 输出调度事件处理器可消费的归并结论。
 *
 * 依赖模块：
 * - domain：执行、需求、决策、验证和工作器结果类型。
 *
 * 注意事项：
 * - 归并策略直接影响任务生命周期，状态判断需要与 stateMachine 保持一致。
 * - 新增验证状态或决策动作时，应同步更新归并规则。
 */
import {
  DecisionReasonCode,
  Demand,
  DemandPhase,
  DemandState,
  Execution,
  ExecutionState,
  SubgoalContract,
  SubgoalState,
  VerificationResult,
  VerificationStatus,
  WorkerResult,
  nowIso
} from "../../../domain/index.js";

export interface ReconciliationOutcome {
  demand: Demand;
  subgoal: SubgoalContract;
  execution: Execution;
  missionCompleted: boolean;
  replanRequested: boolean;
  decisionReasonCode?: DecisionReasonCode;
  decisionPrompt?: string;
}

export class ReconciliationService {
  /**
   * 函数作用：归并执行结果和验证结果，决定后续调度动作。
   *
   * 参数说明：
   * - input：包含需求、子目标、执行、工作器结果、验证结果和当前决策列表。
   *
   * 返回值：
   * - ReconciliationOutcome：包含下一步动作和更新后的实体快照。
   */
  reconcile(input: {
    demand: Demand;
    subgoal: SubgoalContract;
    execution: Execution;
    workerResult: WorkerResult;
    verification: VerificationResult;
  }): ReconciliationOutcome {
    const timestamp = nowIso();
    const demand = { ...input.demand, updated_at: timestamp };
    const subgoal = { ...input.subgoal, updated_at: timestamp };
    const execution = { ...input.execution, updated_at: timestamp };

    switch (input.verification.verified_status) {
      case VerificationStatus.VERIFIED_DONE:
        demand.state = DemandState.COMPLETED;
        demand.current_phase = DemandPhase.COMPLETED;
        demand.progress_percent = 100;
        subgoal.state = SubgoalState.DONE;
        execution.state = ExecutionState.DONE;
        execution.completed_at = timestamp;
        return {
          demand,
          subgoal,
          execution,
          missionCompleted: true,
          replanRequested: false
        };
      case VerificationStatus.PARTIAL:
        demand.state = DemandState.ACTIVE;
        demand.current_phase = DemandPhase.EXECUTION;
        demand.progress_percent = Math.min(90, demand.progress_percent + 35);
        subgoal.state = SubgoalState.READY;
        execution.state = ExecutionState.DONE;
        execution.completed_at = timestamp;
        return {
          demand,
          subgoal,
          execution,
          missionCompleted: false,
          replanRequested: true
        };
      case VerificationStatus.UNVERIFIABLE:
        demand.state = DemandState.PENDING_DECISION;
        demand.current_phase = DemandPhase.REVIEW;
        subgoal.state = SubgoalState.BLOCKED;
        execution.state = ExecutionState.FAILED;
        execution.completed_at = timestamp;
        return {
          demand,
          subgoal,
          execution,
          missionCompleted: false,
          replanRequested: false,
          decisionReasonCode: DecisionReasonCode.UNVERIFIABLE_RESULT,
          decisionPrompt: input.verification.notes
        };
      case VerificationStatus.FAILED:
      default:
        demand.state = DemandState.FAILED;
        demand.current_phase = DemandPhase.FAILED;
        subgoal.state = SubgoalState.FAILED;
        execution.state = ExecutionState.FAILED;
        execution.completed_at = timestamp;
        return {
          demand,
          subgoal,
          execution,
          missionCompleted: false,
          replanRequested: false,
          decisionReasonCode: DecisionReasonCode.BLOCKED,
          decisionPrompt: input.workerResult.blocker_reason?.message ?? "Execution failed"
        };
    }
  }
}
