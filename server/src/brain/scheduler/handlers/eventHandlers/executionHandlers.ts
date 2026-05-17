/**
 * 文件名称：executionHandlers.ts
 * 文件作用：执行事件处理器模块，负责处理执行创建、派发、心跳、结果回收和停止请求。
 *
 * 主要职责：
 * 1. 为执行分配可用工作器并完成派发。
 * 2. 更新执行和工作器的运行状态。
 * 3. 处理工作器心跳与最终结果。
 * 4. 在执行停止请求时取消适配器任务并生成失败结果。
 *
 * 依赖模块：
 * - domain：执行、工作器、事件和状态类型。
 * - event_bus/types：处理器上下文。
 * - stateMachine：执行状态转换。
 * - executionRuntime：工作器槽位同步和失败结果构造。
 *
 * 注意事项：
 * - 派发逻辑应尊重工作器启用状态、容量和适配器注册情况。
 * - 处理结果时要确保执行、工作器和后续验证事件保持一致。
 */
import {
  createEvent,
  DemandPhase,
  DemandState,
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
import { collectWorkspaceGrants } from "../../../dispatch/dispatcher/service.js";
import {
  ACTIVE_EXECUTION_STATES,
  transitionDemand,
  transitionExecution,
  transitionSubgoal
} from "../stateMachine.js";
import {
  createWorkerFailureResult,
  syncWorkerExecutionSlots
} from "../executionRuntime.js";

const logger = createLogger("handlers:execution");
const verifyingWorkerResultExecutions = new Set<string>();

/**
 * 函数作用：处理执行创建事件并选择可用工作器。
 *
 * 参数说明：
 * - event：执行创建事件。
 * - ctx：事件处理器上下文。
 *
 * 返回值：
 * - Promise<HandlerResult>：执行派发准备结果。
 */
export async function onExecutionCreated(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const payload = event.payload as { execution: any; dispatch_packet: any };
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  const subgoal = await ctx.repositories.subgoals.getById(event.subgoal_id ?? "");
  const worker = await ctx.repositories.workers.getById(event.worker_id ?? "");
  if (!demand || !subgoal || !worker) {
    logger.warn({ demandId: event.demand_id, subgoalId: event.subgoal_id, workerId: event.worker_id, executionId: event.execution_id }, "忽略执行创建事件，因为必要记录未找到");
    return {};
  }

  logger.info({ demandId: demand.demand_id, subgoalId: subgoal.subgoal_id, executionId: payload.execution.execution_id, workerId: worker.worker_id }, "正在保存已创建的执行");
  await ctx.repositories.executions.upsert(payload.execution);

  // 普通 build 子目标派发会把 demand 推到 ACTIVE/EXECUTION；
  // 但 recon 子目标在 clarification 阶段就可能派出去，此时 demand 还在 PENDING_ALIGNMENT，
  // 状态机不允许 PENDING_ALIGNMENT 直接跳到 ACTIVE。这种情况下让 demand 状态/阶段保持不动，
  // 只把 waiting_on 改成 worker_result 标识系统在等 recon worker 回报。
  const isReconInClarification = subgoal.kind === "recon" && !demand.operational_objective;
  const nextDemandState = isReconInClarification ? demand.state : DemandState.ACTIVE;
  const nextPhase = isReconInClarification ? demand.current_phase : DemandPhase.EXECUTION;

  await ctx.repositories.demands.upsert(transitionDemand(demand, {
    state: nextDemandState,
    current_phase: nextPhase
  }, {
    phase: nextPhase,
    waiting_on: "worker_result",
    latest_checkpoint: payload.execution.execution_id,
    progress_note: isReconInClarification
      ? `Recon worker dispatched for clarification: ${subgoal.title}`
      : `Dispatched subgoal ${subgoal.subgoal_id}`
  }));
  await ctx.repositories.subgoals.upsert(transitionSubgoal(subgoal, { state: SubgoalState.DISPATCHED }));
  await ctx.repositories.workers.upsert({
    ...worker,
    status: WorkerRegistryStatus.BUSY,
    current_execution_ids: [...worker.current_execution_ids, payload.execution.execution_id],
    updated_at: nowIso()
  });

  return {
    events: [
      createEvent(
        EventType.EXECUTION_DISPATCHED,
        {
          adapter_type: worker.adapter_type,
          runtime_type: worker.runtime_type,
          dispatch_started_at: nowIso()
        },
        {
          demand_id: event.demand_id,
          subgoal_id: event.subgoal_id,
          execution_id: event.execution_id,
          worker_id: event.worker_id
        }
      )
    ]
  };
}

/**
 * 函数作用：处理执行派发事件并启动工作器执行。
 *
 * 参数说明：
 * - event：执行派发事件。
 * - ctx：事件处理器上下文。
 *
 * 返回值：
 * - Promise<HandlerResult>：执行和工作器状态更新结果。
 */
export async function onExecutionDispatched(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const execution = await ctx.repositories.executions.getById(event.execution_id ?? "");
  const worker = await ctx.repositories.workers.getById(event.worker_id ?? "");
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  const subgoal = await ctx.repositories.subgoals.getById(event.subgoal_id ?? "");
  const settings = await ctx.repositories.loadSettings();
  if (!execution || !worker || !demand || !subgoal) {
    logger.warn({ demandId: event.demand_id, subgoalId: event.subgoal_id, executionId: event.execution_id, workerId: event.worker_id }, "忽略执行派发事件，因为必要记录未找到");
    return {};
  }
  // recon 子目标在 clarification 阶段可派发，此时 demand.operational_objective 仍为 null。
  // dispatcher.buildPacket 已对 OO=null 做占位兜底，所以不再强制 OO 必须存在。
  if (subgoal.kind !== "recon" && !demand.operational_objective) {
    logger.warn({
      demandId: demand.demand_id,
      subgoalId: subgoal.subgoal_id,
      subgoalKind: subgoal.kind ?? "build"
    }, "build 类 subgoal 派发时 demand.operational_objective 为 null，使用 dispatcher 占位 OO 兜底");
  }

  const adapter = ctx.adapterRegistry.getAdapter(worker.worker_id);
  if (!adapter) {
    logger.error({ workerId: worker.worker_id, executionId: execution.execution_id }, "无法派发执行，因为工作器适配器未注册");
    return {};
  }

  const memorySnapshot = await ctx.memoryManager.getDispatchMemorySnapshot(ctx.repositories, demand.demand_id);
  const workspaceGrants = collectWorkspaceGrants(settings, demand);

  // Claude Code worker 跨 subgoal 续接 session：找最近一条带 claude_session_id 的同 demand execution
  let claudeResumeSessionId: string | null = null;
  if (worker.adapter_type === "claude_code") {
    const allExecutions = await ctx.repositories.executions.list();
    const priors = allExecutions
      .filter((item) => item.demand_id === demand.demand_id && item.execution_id !== execution.execution_id)
      .sort((left, right) => (right.created_at ?? "").localeCompare(left.created_at ?? ""));
    for (const prior of priors) {
      const meta = (prior.adapter_meta ?? {}) as Record<string, unknown>;
      const sid = meta.claude_session_id;
      if (typeof sid === "string" && sid.trim().length > 0) {
        claudeResumeSessionId = sid;
        logger.info({
          demandId: demand.demand_id,
          executionId: execution.execution_id,
          priorExecutionId: prior.execution_id,
          claudeResumeSessionId
        }, "为 Claude Code 派发注入上一次会话 ID 用于续接");
        break;
      }
    }
  }

  const packet = ctx.dispatcher.buildPacket({
    demand,
    subgoal,
    execution,
    worker,
    workspaceRoot: settings.workspace_root,
    heartbeatSeconds: settings.runtime.heartbeat_interval_seconds,
    timeoutSeconds: settings.runtime.execution_timeout_seconds,
    memorySnapshot,
    workspaceGrants,
    claudeResumeSessionId
  });

  const startedAt = nowIso();
  const runningExecution = transitionExecution(execution, {
    state: ExecutionState.RUNNING,
    started_at: startedAt
  });
  const executingSubgoal = transitionSubgoal(subgoal, { state: SubgoalState.EXECUTING });

  try {
    ctx.adapterRegistry.bindExecution(execution.execution_id, worker.worker_id);
    logger.info({ demandId: demand.demand_id, subgoalId: subgoal.subgoal_id, executionId: execution.execution_id, workerId: worker.worker_id }, "正在启动工作器执行");
    await adapter.startExecution(packet);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, executionId: execution.execution_id, workerId: worker.worker_id }, "工作器执行启动失败");
    await ctx.repositories.executions.upsert(runningExecution);
    await ctx.repositories.subgoals.upsert(executingSubgoal);
    return {
      events: [
        createEvent(
          EventType.WORKER_RESULT_RECEIVED,
          {
            worker_result: createWorkerFailureResult({
              executionId: execution.execution_id,
              workerId: worker.worker_id,
              code: "WORKER_START_FAILED",
              message,
              startedAt,
              suggestedNextStep: "Inspect worker command, cwd, environment, and retry or request human decision"
            })
          },
          {
            demand_id: event.demand_id,
            subgoal_id: event.subgoal_id,
            execution_id: event.execution_id,
            worker_id: event.worker_id
          }
        )
      ]
    };
  }

  await ctx.repositories.executions.upsert(runningExecution);
  await ctx.repositories.subgoals.upsert(executingSubgoal);
  logger.info({ executionId: execution.execution_id, workerId: worker.worker_id }, "工作器执行已启动");
  return {};
}

/**
 * 函数作用：处理工作器心跳事件并刷新执行状态。
 *
 * 参数说明：
 * - event：工作器心跳事件。
 * - ctx：事件处理器上下文。
 *
 * 返回值：
 * - Promise<HandlerResult>：心跳写入后的处理结果。
 */
export async function onWorkerHeartbeat(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const execution = await ctx.repositories.executions.getById(event.execution_id ?? "");
  if (!execution) {
    logger.warn({ executionId: event.execution_id }, "忽略心跳事件，因为未找到对应执行");
    return {};
  }

  const payload = event.payload as { heartbeat: { emitted_at: string; status: any } };
  logger.debug({ executionId: execution.execution_id, status: payload.heartbeat.status }, "收到工作器心跳");
  await ctx.repositories.executions.upsert(transitionExecution(execution, {
    last_heartbeat_at: payload.heartbeat.emitted_at,
    latest_worker_status: payload.heartbeat.status
  }));
  return {};
}

/**
 * 函数作用：处理工作器结果事件并触发验证流程。
 *
 * 参数说明：
 * - event：工作器结果事件。
 * - ctx：事件处理器上下文。
 *
 * 返回值：
 * - Promise<HandlerResult>：执行结果写入和验证事件发布结果。
 */
export async function onWorkerResult(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const execution = await ctx.repositories.executions.getById(event.execution_id ?? "");
  const subgoal = await ctx.repositories.subgoals.getById(event.subgoal_id ?? "");
  if (!execution || !subgoal) {
    logger.warn({ executionId: event.execution_id, subgoalId: event.subgoal_id }, "忽略工作器结果，因为未找到执行或子目标");
    return {};
  }
  if (verifyingWorkerResultExecutions.has(execution.execution_id)) {
    logger.debug({ executionId: execution.execution_id }, "Ignoring duplicate worker result while verification is in flight");
    return {};
  }
  if (execution.state === ExecutionState.VERIFYING) {
    logger.debug({ executionId: execution.execution_id }, "Ignoring duplicate worker result for execution already verifying");
    return {};
  }
  if (!ACTIVE_EXECUTION_STATES.has(execution.state)) {
    logger.debug({ executionId: execution.execution_id, state: execution.state }, "忽略非活跃执行的工作器结果");
    return {};
  }
  const payload = event.payload as { worker_result: any };
  verifyingWorkerResultExecutions.add(execution.execution_id);
  try {
  logger.info({ executionId: execution.execution_id, subgoalId: subgoal.subgoal_id, workerStatus: payload.worker_result.worker_status }, "收到工作器结果，开始验证");
  const resultExecution = execution.state === ExecutionState.QUEUED
    ? transitionExecution(execution, {
        state: ExecutionState.RUNNING,
        started_at: execution.started_at ?? nowIso()
      })
    : execution;
  const resultSubgoal = subgoal.state === SubgoalState.DISPATCHED
    ? transitionSubgoal(subgoal, { state: SubgoalState.EXECUTING })
    : subgoal;

  await ctx.repositories.executions.upsert(transitionExecution(resultExecution, {
    state: ExecutionState.VERIFYING,
    result_status: payload.worker_result.worker_status,
    claimed_outcome: payload.worker_result.claimed_outcome ?? null,
    compressed_history: payload.worker_result.compressed_history,
    artifacts: payload.worker_result.produced_artifacts,
    adapter_meta: payload.worker_result.adapter_meta ?? {}
  }));
  await ctx.repositories.subgoals.upsert(transitionSubgoal(resultSubgoal, { state: SubgoalState.VERIFYING }));

  const settings = await ctx.repositories.loadSettings();
  const verification = await ctx.verifier.verify(subgoal.subgoal_id, subgoal, payload.worker_result, settings);
  return {
    events: [
      createEvent(
        EventType.VERIFICATION_COMPLETED,
        { verification_result: verification },
        {
          demand_id: event.demand_id,
          subgoal_id: event.subgoal_id,
          execution_id: event.execution_id,
          worker_id: event.worker_id
        }
      )
    ]
  };
  } finally {
    verifyingWorkerResultExecutions.delete(execution.execution_id);
  }
}

/**
 * 函数作用：处理执行停止请求并取消对应工作器任务。
 *
 * 参数说明：
 * - event：执行停止请求事件。
 * - ctx：事件处理器上下文。
 *
 * 返回值：
 * - Promise<HandlerResult>：执行停止和失败结果生成后的处理结果。
 */
export async function onExecutionStopRequested(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const execution = await ctx.repositories.executions.getById(event.execution_id ?? "");
  if (!execution || !ACTIVE_EXECUTION_STATES.has(execution.state)) {
    logger.debug({ executionId: event.execution_id, state: execution?.state }, "忽略停止请求，因为执行不是活跃状态");
    return {};
  }

  const payload = event.payload as { reason?: string };
  const shouldCancel = payload.reason === "demand_cancelled";
  const adapter = ctx.adapterRegistry.getExecutionAdapter(execution.execution_id);
  let stopError: string | null = null;
  if (adapter) {
    try {
      logger.info({ executionId: execution.execution_id, workerId: execution.worker_id, reason: payload.reason }, "正在停止工作器执行");
      await adapter.stopExecution(execution.execution_id);
    } catch (error) {
      stopError = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, executionId: execution.execution_id }, "工作器执行停止失败");
    }
  } else {
    logger.warn({ executionId: execution.execution_id, workerId: execution.worker_id }, "停止执行时未找到执行适配器");
  }

  await ctx.repositories.executions.upsert(transitionExecution(execution, {
    state: shouldCancel ? ExecutionState.CANCELLED : ExecutionState.INTERRUPTED,
    completed_at: nowIso()
  }));

  const subgoal = await ctx.repositories.subgoals.getById(execution.subgoal_id);
  if (subgoal && ![SubgoalState.DONE, SubgoalState.FAILED, SubgoalState.CANCELLED].includes(subgoal.state)) {
    await ctx.repositories.subgoals.upsert(transitionSubgoal(subgoal, {
      state: shouldCancel ? SubgoalState.CANCELLED : SubgoalState.BLOCKED
    }));
  }

  await syncWorkerExecutionSlots(execution.worker_id, ctx, stopError);
  logger.info({ executionId: execution.execution_id, workerId: execution.worker_id, state: shouldCancel ? ExecutionState.CANCELLED : ExecutionState.INTERRUPTED }, "执行已停止");
  return {};
}
