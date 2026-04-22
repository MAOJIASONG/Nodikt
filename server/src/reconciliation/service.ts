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
} from "../domain/index.js";

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
