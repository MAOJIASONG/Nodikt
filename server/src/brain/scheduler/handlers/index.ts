/**
 * 文件名称：index.ts
 * 文件作用：调度事件处理器注册入口，负责将事件类型映射到具体处理函数。
 *
 * 主要职责：
 * 1. 聚合需求、规划、执行、审查和运维处理器。
 * 2. 构建 EventType 到 EventHandler 的映射表。
 * 3. 为事件总线提供统一处理器集合。
 *
 * 依赖模块：
 * - domain：事件类型枚举。
 * - event_bus/types：处理器映射类型。
 * - eventHandlers/*：各业务域事件处理函数。
 * - logger：处理器注册日志。
 *
 * 注意事项：
 * - 新增事件类型后，需在这里注册对应处理器，否则事件只会被持久化而不会推进流程。
 * - 映射表应保持清晰分组，便于排查调度链路。
 */
import { EventType } from "../../../domain/index.js";
import { HandlerMap } from "../event_bus/types.js";
import { createLogger } from "../../../logger.js";
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
  onExecutionTimeoutDetected,
  onOpsAlert,
  onOpsRecoveryFailed,
  onWorkerHealthChecked
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
  onSubgoalRetryRequested,
  onVerificationCompleted
} from "./eventHandlers/reviewHandlers.js";

const logger = createLogger("handlers");

/**
 * 函数作用：创建事件类型到处理器函数的映射表。
 *
 * 参数说明：
 * - 无。
 *
 * 返回值：
 * - HandlerMap：事件总线使用的处理器集合。
 *
 * 注意事项：
 * - 新增事件类型后，应在这里注册对应处理器。
 */
export function createHandlers(): HandlerMap {
  const handlers = {
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
    [EventType.SUBGOAL_RETRY_REQUESTED]: onSubgoalRetryRequested,
    [EventType.DECISION_REQUEST_CREATED]: onDecisionRequestCreated,
    [EventType.DECISION_RESPONSE_RECEIVED]: onDecisionResponseReceived,
    [EventType.DEMAND_PAUSED]: onDemandPaused,
    [EventType.DEMAND_RESUMED]: onDemandResumed,
    [EventType.DEMAND_CANCELLED]: onDemandCancelled,
    [EventType.MISSION_COMPLETED]: onMissionCompleted,
    [EventType.EXECUTION_STOP_REQUESTED]: onExecutionStopRequested,
    [EventType.EXECUTION_TIMEOUT_DETECTED]: onExecutionTimeoutDetected,
    [EventType.WORKER_HEALTH_CHECKED]: onWorkerHealthChecked,
    [EventType.OPS_RECOVERY_FAILED]: onOpsRecoveryFailed,
    [EventType.OPS_ALERT]: onOpsAlert
  };
  logger.info({ handlerCount: Object.keys(handlers).length }, "调度器事件处理器已注册");
  return handlers;
}
