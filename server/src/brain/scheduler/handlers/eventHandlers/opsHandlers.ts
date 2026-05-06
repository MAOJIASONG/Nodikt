/**
 * 文件名称：opsHandlers.ts
 * 文件作用：运维事件处理器模块，负责处理执行超时、工作器健康检查、恢复失败和告警事件。
 *
 * 主要职责：
 * 1. 将超时执行标记为失败或进入恢复流程。
 * 2. 根据恢复策略选择原工作器重试、备用工作器重试或升级告警。
 * 3. 更新工作器健康状态和执行槽位。
 * 4. 记录无法自动恢复的运维告警。
 *
 * 依赖模块：
 * - domain：运维事件、执行和工作器状态类型。
 * - event_bus/types：处理器上下文。
 * - ops/recoveryPolicy：恢复策略选择。
 * - executionRuntime：槽位同步。
 *
 * 注意事项：
 * - 运维处理器应避免重复恢复同一个失败执行。
 * - 自动恢复次数和目标工作器选择会影响系统稳定性，需要配合测试维护。
 */
import {
  createEvent,
  DecisionReasonCode,
  EventType,
  ExecutionState,
  HandlerResult,
  SchedulerEvent,
  SubgoalState,
  WorkerRegistryStatus,
  nowIso
} from "../../../../domain/index.js";
import { HandlerContext } from "../../event_bus/types.js";
import { createLogger } from "../../../../logger.js";
import { chooseExecutionRecovery } from "../../../ops/recoveryPolicy.js";
import { syncWorkerExecutionSlots } from "../executionRuntime.js";
import {
  ACTIVE_EXECUTION_STATES,
  transitionExecution,
  transitionSubgoal
} from "../stateMachine.js";

const logger = createLogger("handlers:ops");

async function createOpsDecision(
  event: SchedulerEvent,
  ctx: HandlerContext,
  input: {
    message: string;
    code: string;
    severity?: string;
  }
): Promise<HandlerResult> {
  const execution = await ctx.repositories.executions.getById(event.execution_id ?? "");
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (!demand) {
    logger.warn({ demandId: event.demand_id, executionId: event.execution_id }, "Ops alert did not match a demand");
    return {};
  }

  const settings = await ctx.repositories.loadSettings();
  const prompt = await ctx.decisionService.buildPrompt({
    demand,
    settings,
    source: "ops",
    reasonCode: DecisionReasonCode.OPS_ALERT,
    fallbackPrompt: input.message
  });
  const decision = ctx.decisionService.createRequest({
    demandId: demand.demand_id,
    source: "ops",
    reasonCode: DecisionReasonCode.OPS_ALERT,
    prompt,
    executionId: execution?.execution_id ?? null,
    subgoalId: execution?.subgoal_id ?? event.subgoal_id ?? null,
    metadata: {
      ops_code: input.code,
      ops_severity: input.severity ?? "error"
    }
  });

  logger.info({
    demandId: demand.demand_id,
    executionId: execution?.execution_id,
    decisionId: decision.decision_id
  }, "Created decision request from Ops alert");

  return {
    events: [
      createEvent(EventType.DECISION_REQUEST_CREATED, { decision_request: decision }, {
        demand_id: demand.demand_id,
        subgoal_id: execution?.subgoal_id ?? event.subgoal_id ?? null,
        execution_id: execution?.execution_id ?? event.execution_id ?? null,
        decision_id: decision.decision_id
      })
    ]
  };
}

async function prepareSubgoalForRetry(event: SchedulerEvent, ctx: HandlerContext): Promise<void> {
  const subgoal = await ctx.repositories.subgoals.getById(event.subgoal_id ?? "");
  if (!subgoal || subgoal.state === SubgoalState.READY) {
    return;
  }

  if (subgoal.state === SubgoalState.PLANNED || subgoal.state === SubgoalState.BLOCKED) {
    await ctx.repositories.subgoals.upsert(transitionSubgoal(subgoal, { state: SubgoalState.READY }));
    return;
  }

  if ([SubgoalState.DISPATCHED, SubgoalState.EXECUTING, SubgoalState.VERIFYING].includes(subgoal.state)) {
    const blocked = transitionSubgoal(subgoal, { state: SubgoalState.BLOCKED });
    await ctx.repositories.subgoals.upsert(transitionSubgoal(blocked, { state: SubgoalState.READY }));
  }
}

async function blockSubgoalIfPossible(event: SchedulerEvent, ctx: HandlerContext): Promise<void> {
  const subgoal = await ctx.repositories.subgoals.getById(event.subgoal_id ?? "");
  if (!subgoal || [SubgoalState.DONE, SubgoalState.FAILED, SubgoalState.CANCELLED, SubgoalState.BLOCKED].includes(subgoal.state)) {
    return;
  }

  if ([SubgoalState.READY, SubgoalState.DISPATCHED, SubgoalState.EXECUTING, SubgoalState.VERIFYING].includes(subgoal.state)) {
    await ctx.repositories.subgoals.upsert(transitionSubgoal(subgoal, { state: SubgoalState.BLOCKED }));
  }
}

/**
 * 函数作用：处理执行超时事件并尝试自动恢复。
 *
 * 参数说明：
 * - event：执行超时检测事件。
 * - ctx：事件处理器上下文。
 *
 * 返回值：
 * - Promise<HandlerResult>：重试、切换工作器或升级告警后的处理结果。
 */
export async function onExecutionTimeoutDetected(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const execution = await ctx.repositories.executions.getById(event.execution_id ?? "");
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  const subgoal = await ctx.repositories.subgoals.getById(event.subgoal_id ?? "");
  if (!execution || !demand || !subgoal || !demand.operational_objective) {
    logger.warn({
      demandId: event.demand_id,
      subgoalId: event.subgoal_id,
      executionId: event.execution_id
    }, "Ignoring timeout event because required records were not found");
    return {};
  }

  if (!ACTIVE_EXECUTION_STATES.has(execution.state)) {
    logger.debug({ executionId: execution.execution_id, state: execution.state }, "Ignoring timeout for inactive execution");
    return {};
  }

  const adapter = ctx.adapterRegistry.getExecutionAdapter(execution.execution_id);
  let stopError: string | null = null;
  if (adapter) {
    try {
      await adapter.stopExecution(execution.execution_id);
    } catch (error) {
      stopError = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, executionId: execution.execution_id }, "Failed to stop timed out execution");
    }
  }

  await ctx.repositories.executions.upsert(transitionExecution(execution, {
    state: ExecutionState.TIMEOUT,
    completed_at: nowIso()
  }));
  await syncWorkerExecutionSlots(execution.worker_id, ctx, stopError);

  const settings = await ctx.repositories.loadSettings();
  const workers = (await ctx.repositories.workers.list()).filter((worker) => ctx.adapterRegistry.getAdapter(worker.worker_id));
  const recovery = chooseExecutionRecovery({
    execution,
    workers,
    settings
  });

  if (!recovery.worker) {
    await blockSubgoalIfPossible(event, ctx);
    return {
      events: [
        createEvent(EventType.OPS_RECOVERY_ATTEMPTED, {
          strategy: recovery.strategy,
          reason: recovery.reason,
          previous_execution_id: execution.execution_id,
          attempt: recovery.nextAttempt,
          max_retry_count: recovery.maxRetryCount
        }, {
          demand_id: demand.demand_id,
          subgoal_id: subgoal.subgoal_id,
          execution_id: execution.execution_id,
          worker_id: execution.worker_id
        }),
        createEvent(EventType.OPS_ALERT, {
          code: "EXECUTION_TIMEOUT_UNRECOVERED",
          message: recovery.reason,
          severity: "error",
          details: {
            previous_execution_id: execution.execution_id,
            attempt: execution.attempt,
            max_retry_count: settings.runtime.max_retry_count
          }
        }, {
          demand_id: demand.demand_id,
          subgoal_id: subgoal.subgoal_id,
          execution_id: execution.execution_id,
          worker_id: execution.worker_id
        })
      ]
    };
  }

  await prepareSubgoalForRetry(event, ctx);
  const retrySubgoal = {
    ...subgoal,
    state: SubgoalState.READY
  };
  const retryExecution = ctx.dispatcher.buildExecution({
    demand,
    subgoal: retrySubgoal,
    worker: recovery.worker,
    attempt: recovery.nextAttempt
  });
  const packet = ctx.dispatcher.buildPacket({
    demand,
    subgoal: retrySubgoal,
    execution: retryExecution,
    worker: recovery.worker,
    workspaceRoot: settings.workspace_root,
    heartbeatSeconds: settings.runtime.heartbeat_interval_seconds,
    timeoutSeconds: settings.runtime.execution_timeout_seconds
  });

  logger.warn({
    demandId: demand.demand_id,
    previousExecutionId: execution.execution_id,
    nextExecutionId: retryExecution.execution_id,
    strategy: recovery.strategy,
    nextAttempt: recovery.nextAttempt
  }, "Ops is retrying timed out execution");

  return {
    events: [
      createEvent(EventType.OPS_RECOVERY_ATTEMPTED, {
        strategy: recovery.strategy,
        reason: recovery.reason,
        previous_execution_id: execution.execution_id,
        next_execution_id: retryExecution.execution_id,
        attempt: recovery.nextAttempt,
        max_retry_count: recovery.maxRetryCount
      }, {
        demand_id: demand.demand_id,
        subgoal_id: subgoal.subgoal_id,
        execution_id: execution.execution_id,
        worker_id: recovery.worker.worker_id
      }),
      createEvent(EventType.EXECUTION_CREATED, { execution: retryExecution, dispatch_packet: packet }, {
        demand_id: demand.demand_id,
        subgoal_id: subgoal.subgoal_id,
        execution_id: retryExecution.execution_id,
        worker_id: recovery.worker.worker_id
      })
    ]
  };
}

/**
 * 函数作用：处理工作器健康检查事件并更新工作器状态。
 *
 * 参数说明：
 * - event：工作器健康检查事件。
 * - ctx：事件处理器上下文。
 *
 * 返回值：
 * - Promise<HandlerResult>：工作器健康状态更新结果。
 */
export async function onWorkerHealthChecked(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const worker = await ctx.repositories.workers.getById(event.worker_id ?? "");
  const payload = event.payload as { ok: boolean; message: string; checked_at: string };
  if (!worker) {
    logger.warn({ workerId: event.worker_id }, "Ignoring worker health check because worker was not found");
    return {};
  }

  await ctx.repositories.workers.upsert({
    ...worker,
    status: worker.is_enabled
      ? payload.ok
        ? worker.current_execution_ids.length > 0 ? WorkerRegistryStatus.BUSY : WorkerRegistryStatus.IDLE
        : WorkerRegistryStatus.ERROR
      : WorkerRegistryStatus.DISABLED,
    last_seen_at: payload.ok ? payload.checked_at : worker.last_seen_at,
    last_error: payload.ok ? null : payload.message,
    updated_at: nowIso()
  });

  if (!payload.ok) {
    return {
      events: [
        createEvent(EventType.OPS_ALERT, {
          code: "WORKER_HEALTH_CHECK_FAILED",
          message: payload.message,
          severity: "warning",
          details: { worker_id: worker.worker_id }
        }, {
          worker_id: worker.worker_id
        })
      ]
    };
  }

  return {};
}

/**
 * 函数作用：处理自动恢复失败事件。
 *
 * 参数说明：
 * - event：运维恢复失败事件。
 * - ctx：事件处理器上下文。
 *
 * 返回值：
 * - Promise<HandlerResult>：恢复失败记录结果。
 */
export async function onOpsRecoveryFailed(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const payload = event.payload as { code: string; message: string };
  return createOpsDecision(event, ctx, {
    code: payload.code,
    message: payload.message,
    severity: "error"
  });
}

/**
 * 函数作用：处理运维告警事件。
 *
 * 参数说明：
 * - event：运维告警事件。
 * - ctx：事件处理器上下文。
 *
 * 返回值：
 * - Promise<HandlerResult>：告警记录结果。
 */
export async function onOpsAlert(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const execution = await ctx.repositories.executions.getById(event.execution_id ?? "");
  const payload = event.payload as { code?: string; message: string; severity?: string };
  logger.warn({
    demandId: event.demand_id,
    executionId: event.execution_id,
    code: payload.code,
    severity: payload.severity
  }, "Received Ops alert");

  if (execution && ACTIVE_EXECUTION_STATES.has(execution.state)) {
    await ctx.repositories.executions.upsert(transitionExecution(execution, {
      state: ExecutionState.TIMEOUT,
      completed_at: nowIso()
    }));
    await syncWorkerExecutionSlots(execution.worker_id, ctx);
    await blockSubgoalIfPossible(event, ctx);
    logger.warn({ executionId: execution.execution_id, previousState: execution.state }, "Marked execution timed out from Ops alert");
  }

  return createOpsDecision(event, ctx, {
    code: payload.code ?? "OPS_ALERT",
    message: payload.message,
    severity: payload.severity
  });
}
