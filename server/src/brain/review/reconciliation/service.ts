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
  /**
   * 仅在 subgoal.kind === "recon" 时非空。reviewHandlers 用它决定 barrier 完成后 publish
   * USER_INPUT_RECEIVED(recon_findings) 还是 REPLAN_REQUESTED(recon_completed)。
   * 不再依赖 reviewHandlers 自己的 verified_status 白名单判断。
   */
  reconCompletion?: ReconCompletionOutcome;
}

/**
 * 一条"recon subgoal 完成"事件应往哪个下游推进。
 * reconciliation 是唯一计算这个的地方；reviewHandlers 不再自己判断。
 *
 *  - "clarifier_feedback": 把 finding 当成 USER_INPUT_RECEIVED(input_kind="recon_findings")
 *    回灌给 clarifier。用在 demand 还没生成 operational_objective 的 clarification 阶段。
 *  - "planner_replan": publish REPLAN_REQUESTED(reason="recon_completed") 触发 planner 重新规划。
 *    用在 demand 已经有 operational_objective 的 planning/execution 阶段。
 */
export type ReconNextStep = "clarifier_feedback" | "planner_replan";

export interface ReconFinding {
  subgoal_id: string;
  subgoal_title: string;
  /** 正常情况是 worker 的 claimed_outcome；recon 工具级失败时是 [recon FAILED: <status>] <reason>。 */
  claimed_outcome: string;
  compressed_history: string;
  captured_at: string;
  /** true 时该 finding 文本以 "[recon FAILED: ...]" 标注，clarifier 应忽略其内容只参考 sibling finding。 */
  failed: boolean;
}

export interface ReconCompletionOutcome {
  nextStep: ReconNextStep;
  finding: ReconFinding;
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

    // recon 类子目标即便验证通过，也不算"任务完成" —— 由下一轮 planner / clarifier 接着推动
    const isReconSubgoal = input.subgoal.kind === "recon";

    switch (input.verification.verified_status) {
      case VerificationStatus.VERIFIED_DONE:
        if (isReconSubgoal) {
          // recon 既可能服务于 plan 阶段（OO 已存在），也可能服务于 clarification 阶段（OO=null）。
          // - OO 存在：把 demand 推到 ACTIVE/PLANNING，后续走 REPLAN_REQUESTED 让 planner 重新生成 build plan。
          // - OO=null：clarification 阶段的 recon，状态机不允许 PENDING_ALIGNMENT → ACTIVE；
          //            保持 demand 当前 state/phase，由 reviewHandlers 把发现回灌给 clarifier。
          const reconForPlan = Boolean(input.demand.operational_objective);
          if (reconForPlan) {
            demand.state = DemandState.ACTIVE;
            demand.current_phase = DemandPhase.PLANNING;
          }
          demand.progress_percent = Math.min(50, demand.progress_percent + 10);
          subgoal.state = SubgoalState.DONE;
          execution.state = ExecutionState.DONE;
          execution.completed_at = timestamp;
          return {
            demand,
            subgoal,
            execution,
            missionCompleted: false,
            replanRequested: true
          };
        }
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
        // recon-in-clarification 部分满足：跟 UNVERIFIABLE/FAILED 同款 —— 不能动 demand state
        // （PENDING_ALIGNMENT → ACTIVE 状态机非法），由 reviewHandlers 的 barrier 把这条 recon 算成
        // "已完成"流转给 clarifier，让它根据现有发现继续决定下一步（NEEDS_RECON / NEEDS_CLARIFICATION / READY）。
        if (isReconSubgoal && !input.demand.operational_objective) {
          subgoal.state = SubgoalState.DONE;     // 部分满足仍当 DONE —— 已经有可用 finding 给 clarifier
          execution.state = ExecutionState.DONE;
          execution.completed_at = timestamp;
          return {
            demand,
            subgoal,
            execution,
            missionCompleted: false,
            replanRequested: true
          };
        }
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
        // recon-in-clarification 验证不过：不能动 demand state（PENDING_ALIGNMENT→PENDING_DECISION 非法），
        // 也不要弹用户决策卡——本来 recon 失败就该静默退化，由 barrier + clarifier 继续推进。
        if (isReconSubgoal && !input.demand.operational_objective) {
          subgoal.state = SubgoalState.FAILED;
          execution.state = ExecutionState.FAILED;
          execution.completed_at = timestamp;
          return {
            demand,
            subgoal,
            execution,
            missionCompleted: false,
            replanRequested: true
          };
        }
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
        if (isReconSubgoal && !input.demand.operational_objective) {
          subgoal.state = SubgoalState.FAILED;
          execution.state = ExecutionState.FAILED;
          execution.completed_at = timestamp;
          return {
            demand,
            subgoal,
            execution,
            missionCompleted: false,
            replanRequested: true
          };
        }
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
