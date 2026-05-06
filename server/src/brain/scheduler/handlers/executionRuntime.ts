/**
 * 文件名称：executionRuntime.ts
 * 文件作用：执行运行时辅助模块，提供活跃执行查询、工作器槽位同步和失败结果构造工具。
 *
 * 主要职责：
 * 1. 判断需求是否仍存在活跃执行。
 * 2. 查询指定需求下的活跃执行列表。
 * 3. 同步工作器 current_execution_ids 和忙闲状态。
 * 4. 从工作器结果中提取错误信息并构造失败结果。
 *
 * 依赖模块：
 * - domain：执行、工作器和结果状态类型。
 * - event_bus/types：处理器上下文。
 * - stateMachine：活跃执行状态集合。
 * - logger：运行时辅助日志。
 *
 * 注意事项：
 * - 工作器槽位同步会影响派发容量判断，必须与执行状态变更保持一致。
 * - 失败结果结构应与工作器适配器真实返回保持兼容。
 */
import {
  Execution,
  WorkerResult,
  WorkerResultStatus,
  WorkerRegistryStatus,
  nowIso
} from "../../../domain/index.js";
import { HandlerContext } from "../event_bus/types.js";
import { createLogger } from "../../../logger.js";
import { ACTIVE_EXECUTION_STATES } from "./stateMachine.js";

const logger = createLogger("handlers:execution_runtime");

/**
 * 函数作用：判断指定需求是否存在活跃执行。
 *
 * 参数说明：
 * - ctx：事件处理器上下文。
 * - demandId：需求 ID。
 *
 * 返回值：
 * - Promise<boolean>：存在运行中、排队中或验证中的执行时返回 true。
 */
export async function demandHasActiveExecutions(
  demandId: string,
  ctx: HandlerContext,
  excludeExecutionId?: string
): Promise<boolean> {
  const executions = await ctx.repositories.executions.list();
  return executions.some((execution) => (
    execution.demand_id === demandId
    && execution.execution_id !== excludeExecutionId
    && ACTIVE_EXECUTION_STATES.has(execution.state)
  ));
}

/**
 * 函数作用：列出指定需求下的活跃执行。
 *
 * 参数说明：
 * - ctx：事件处理器上下文。
 * - demandId：需求 ID。
 *
 * 返回值：
 * - Promise<Execution[]>：活跃执行列表。
 */
export async function listActiveExecutionsForDemand(
  demandId: string,
  ctx: HandlerContext
): Promise<Execution[]> {
  const executions = await ctx.repositories.executions.list();
  return executions.filter((execution) => (
    execution.demand_id === demandId && ACTIVE_EXECUTION_STATES.has(execution.state)
  ));
}

/**
 * 函数作用：同步工作器当前执行槽位和忙闲状态。
 *
 * 参数说明：
 * - ctx：事件处理器上下文。
 * - workerId：需要同步的工作器 ID。
 *
 * 返回值：
 * - Promise<void>：同步完成后无返回数据。
 */
export async function syncWorkerExecutionSlots(
  workerId: string,
  ctx: HandlerContext,
  lastError?: string | null
): Promise<void> {
  const worker = await ctx.repositories.workers.getById(workerId);
  if (!worker) {
    logger.warn({ workerId }, "无法同步工作器执行槽位，因为未找到工作器");
    return;
  }

  const executions = await ctx.repositories.executions.list();
  const activeExecutionIds = worker.current_execution_ids.filter((executionId) => {
    const execution = executions.find((item) => item.execution_id === executionId);
    return execution ? ACTIVE_EXECUTION_STATES.has(execution.state) : false;
  });

  await ctx.repositories.workers.upsert({
    ...worker,
    status: activeExecutionIds.length > 0 ? WorkerRegistryStatus.BUSY : WorkerRegistryStatus.IDLE,
    current_execution_ids: activeExecutionIds,
    last_error: lastError ?? worker.last_error,
    updated_at: nowIso()
  });
  logger.debug({ workerId, activeExecutionIds, lastError }, "工作器执行槽位已同步");
}

/**
 * 函数作用：从工作器结果中提取可读错误信息。
 *
 * 参数说明：
 * - workerResult：包含阻塞原因或压缩历史的工作器结果片段。
 *
 * 返回值：
 * - string | null：提取到错误时返回文本，否则返回 null。
 */
export function extractWorkerError(workerResult: { blocker_reason?: { message?: string | null } | null; compressed_history?: string }): string | null {
  return workerResult.blocker_reason?.message ?? workerResult.compressed_history ?? null;
}

/**
 * 函数作用：构造标准工作器失败结果。
 *
 * 参数说明：
 * - input：包含执行 ID、工作器 ID、错误信息和可选时间戳。
 *
 * 返回值：
 * - WorkerResult：状态为 FAILED 的工作器结果。
 */
export function createWorkerFailureResult(input: {
  executionId: string;
  workerId: string;
  code: string;
  message: string;
  startedAt?: string | null;
  suggestedNextStep?: string;
}): WorkerResult {
  const returnedAt = nowIso();
  const startedAtMs = input.startedAt ? new Date(input.startedAt).getTime() : NaN;
  const durationMs = Number.isFinite(startedAtMs) ? Date.now() - startedAtMs : undefined;

  logger.warn({ executionId: input.executionId, workerId: input.workerId, code: input.code }, "正在创建工作器失败结果");
  return {
    schema_version: "v1",
    execution_id: input.executionId,
    worker_id: input.workerId,
    worker_status: WorkerResultStatus.FAILED,
    claimed_outcome: null,
    compressed_history: input.message,
    produced_artifacts: [],
    blocker_reason: {
      code: input.code,
      message: input.message
    },
    suggested_next_step: input.suggestedNextStep ?? "Inspect the worker error and retry or request human decision",
    budget_used: durationMs === undefined
      ? undefined
      : {
          duration_ms: durationMs
        },
    adapter_meta: {
      failure_code: input.code
    },
    returned_at: returnedAt
  };
}
