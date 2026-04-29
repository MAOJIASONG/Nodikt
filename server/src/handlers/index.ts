import { EventType } from "../domain/index.js";
import { HandlerMap } from "../event_bus/types.js";
import {
  onClarificationCompleted,
  onDemandCancelled,
  onDemandPaused,
  onDemandResumed,
  onMissionCompleted,
  onUserInput
} from "./eventHandlers/demandHandlers.js";
import {
  onExecutionCreated,
  onExecutionDispatched,
  onExecutionStopRequested,
  onWorkerHeartbeat,
  onWorkerResult
} from "./eventHandlers/executionHandlers.js";
import {
  onOpsAlert
} from "./eventHandlers/opsHandlers.js";
import {
  onPlanGenerated,
  onReplanRequested,
  onSubgoalCreated,
  onSubgoalMarkedReady
} from "./eventHandlers/planningHandlers.js";
import {
  onDecisionRequestCreated,
  onDecisionResponseReceived,
  onVerificationCompleted
} from "./eventHandlers/reviewHandlers.js";

export function createHandlers(): HandlerMap {
  return {
    [EventType.USER_INPUT_RECEIVED]: onUserInput,
    [EventType.DEMAND_CLARIFICATION_COMPLETED]: onClarificationCompleted,
    [EventType.REPLAN_REQUESTED]: onReplanRequested,
    [EventType.PLAN_GENERATED]: onPlanGenerated,
    [EventType.SUBGOAL_CREATED]: onSubgoalCreated,
    [EventType.SUBGOAL_MARKED_READY]: onSubgoalMarkedReady,
    [EventType.EXECUTION_CREATED]: onExecutionCreated,
    [EventType.EXECUTION_DISPATCHED]: onExecutionDispatched,
    [EventType.WORKER_HEARTBEAT_RECEIVED]: onWorkerHeartbeat,
    [EventType.WORKER_RESULT_RECEIVED]: onWorkerResult,
    [EventType.VERIFICATION_COMPLETED]: onVerificationCompleted,
    [EventType.DECISION_REQUEST_CREATED]: onDecisionRequestCreated,
    [EventType.DECISION_RESPONSE_RECEIVED]: onDecisionResponseReceived,
    [EventType.DEMAND_PAUSED]: onDemandPaused,
    [EventType.DEMAND_RESUMED]: onDemandResumed,
    [EventType.DEMAND_CANCELLED]: onDemandCancelled,
    [EventType.MISSION_COMPLETED]: onMissionCompleted,
    [EventType.EXECUTION_STOP_REQUESTED]: onExecutionStopRequested,
    [EventType.OPS_ALERT]: onOpsAlert
  };
}
