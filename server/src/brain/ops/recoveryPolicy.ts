/**
 * 文件名称：recoveryPolicy.ts
 * 文件作用：运维恢复策略模块，负责根据执行失败和工作器状态选择恢复动作。
 *
 * 主要职责：
 * 1. 判断当前工作器是否还能继续接收执行。
 * 2. 在重试、切换工作器和升级告警之间做策略选择。
 * 3. 返回调度事件处理器可直接使用的恢复决策。
 *
 * 依赖模块：
 * - domain：执行、工作器和状态类型。
 *
 * 注意事项：
 * - 策略应保持确定性，避免相同状态下产生不可预测恢复行为。
 * - 扩展恢复策略时，应同步更新运维事件处理测试。
 */
import {
  Execution,
  Settings,
  WorkerRegistration,
  WorkerRegistryStatus
} from "../../domain/index.js";

export type OpsRecoveryStrategy = "retry_same_worker" | "retry_alternate_worker" | "escalate";

export interface OpsRecoveryDecision {
  strategy: OpsRecoveryStrategy;
  reason: string;
  nextAttempt: number;
  maxRetryCount: number;
  worker?: WorkerRegistration;
}

function canAcceptExecution(worker: WorkerRegistration): boolean {
  return worker.is_enabled
    && worker.status !== WorkerRegistryStatus.ERROR
    && worker.status !== WorkerRegistryStatus.OFFLINE
    && worker.status !== WorkerRegistryStatus.DISABLED
    && worker.current_execution_ids.length < worker.max_concurrency;
}

/**
 * 函数作用：为失败或超时执行选择恢复策略。
 *
 * 参数说明：
 * - input.execution：需要恢复的执行记录。
 * - input.worker：原执行工作器。
 * - input.availableWorkers：当前可选工作器列表。
 * - input.maxRetries：允许自动重试的最大次数。
 *
 * 返回值：
 * - OpsRecoveryDecision：包含恢复策略、目标工作器和原因说明。
 */
export function chooseExecutionRecovery(input: {
  execution: Execution;
  workers: WorkerRegistration[];
  settings: Settings;
}): OpsRecoveryDecision {
  const maxRetryCount = input.settings.runtime.max_retry_count;
  const nextAttempt = input.execution.attempt + 1;

  if (input.execution.attempt > maxRetryCount) {
    return {
      strategy: "escalate",
      reason: `Retry budget exhausted after attempt ${input.execution.attempt}`,
      nextAttempt,
      maxRetryCount
    };
  }

  const availableWorkers = input.workers.filter(canAcceptExecution);
  const alternateWorker = availableWorkers.find((worker) => worker.worker_id !== input.execution.worker_id);
  if (alternateWorker) {
    return {
      strategy: "retry_alternate_worker",
      reason: `Retrying timed out execution on alternate worker ${alternateWorker.worker_id}`,
      nextAttempt,
      maxRetryCount,
      worker: alternateWorker
    };
  }

  const sameWorker = availableWorkers.find((worker) => worker.worker_id === input.execution.worker_id);
  if (sameWorker) {
    return {
      strategy: "retry_same_worker",
      reason: `Retrying timed out execution on original worker ${sameWorker.worker_id}`,
      nextAttempt,
      maxRetryCount,
      worker: sameWorker
    };
  }

  return {
    strategy: "escalate",
    reason: "Retry budget remains, but no healthy worker has capacity",
    nextAttempt,
    maxRetryCount
  };
}
