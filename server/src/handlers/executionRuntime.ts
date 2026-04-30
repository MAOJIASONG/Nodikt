import {
  Execution,
  WorkerResult,
  WorkerResultStatus,
  WorkerRegistryStatus,
  nowIso
} from "../domain/index.js";
import { HandlerContext } from "../event_bus/types.js";
import { createLogger } from "../logger.js";
import { ACTIVE_EXECUTION_STATES } from "./stateMachine.js";

const logger = createLogger("handlers:execution_runtime");

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

export async function listActiveExecutionsForDemand(
  demandId: string,
  ctx: HandlerContext
): Promise<Execution[]> {
  const executions = await ctx.repositories.executions.list();
  return executions.filter((execution) => (
    execution.demand_id === demandId && ACTIVE_EXECUTION_STATES.has(execution.state)
  ));
}

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

export function extractWorkerError(workerResult: { blocker_reason?: { message?: string | null } | null; compressed_history?: string }): string | null {
  return workerResult.blocker_reason?.message ?? workerResult.compressed_history ?? null;
}

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
