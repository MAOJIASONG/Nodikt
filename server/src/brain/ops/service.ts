/**
 * 文件名称：service.ts
 * 文件作用：运维监控服务，负责周期性检查执行超时、工作器健康和恢复失败场景。
 *
 * 主要职责：
 * 1. 定时扫描运行中的执行和工作器状态。
 * 2. 识别心跳缺失、预算超限和墙钟超时。
 * 3. 发布超时、健康检查、恢复失败和告警相关事件。
 * 4. 在必要时生成工作器失败结果推动调度收敛。
 *
 * 依赖模块：
 * - brain/store/repositories：读取和更新持久化状态。
 * - brain/scheduler/event_bus：发布运维事件。
 * - worker/adapters/registry：读取工作器适配器状态。
 * - logger：运维日志。
 *
 * 注意事项：
 * - 运维监控会主动推动状态变化，新增检查项时需避免重复发布事件。
 * - 超时阈值应与执行预算和工作器心跳协议保持一致。
 */
import {
  createEvent,
  EventType,
  Execution,
  ExecutionState,
  Settings,
  nowIso
} from "../../domain/index.js";
import { EventBus } from "../scheduler/event_bus/eventBus.js";
import { createWorkerFailureResult } from "../scheduler/handlers/executionRuntime.js";
import { createLogger } from "../../logger.js";
import { RepositoryBundle } from "../store/repositories/index.js";
import { AdapterRegistry } from "../../worker/adapters/registry.js";

const logger = createLogger("ops_monitor");

type TimeoutReason = "heartbeat_missing" | "execution_budget_exceeded" | "wall_clock_timeout";

export class OpsMonitor {
  private readonly emittedIncidentAt = new Map<string, number>();
  private readonly lastHealthCheckAt = new Map<string, number>();

  constructor(
    private readonly repositories: RepositoryBundle,
    private readonly adapterRegistry: AdapterRegistry
  ) {}

  /**
   * 函数作用：启动运维监控定时器。
   *
   * 参数说明：
   * - eventBus：用于发布超时、健康检查和告警事件的事件总线。
   *
   * 返回值：
   * - NodeJS.Timeout：可用于停止监控的定时器句柄。
   *
   * 注意事项：
   * - 定时器会周期性读取并可能更新仓储状态。
   */
  start(eventBus: EventBus): NodeJS.Timeout {
    return setInterval(async () => {
      try {
        const settings = await this.repositories.loadSettings();
        await this.checkWorkerHealth(eventBus, settings);
        await this.checkExecutions(eventBus, settings);
      } catch (error) {
        logger.error({ err: error }, "Ops monitor tick failed");
      }
    }, 2000);
  }

  private async checkWorkerHealth(eventBus: EventBus, settings: Settings): Promise<void> {
    const workers = await this.repositories.workers.list();
    const intervalMs = Math.max(5, settings.runtime.heartbeat_interval_seconds) * 1000;

    for (const worker of workers) {
      const lastCheckedAt = this.lastHealthCheckAt.get(worker.worker_id) ?? 0;
      if (Date.now() - lastCheckedAt < intervalMs) {
        continue;
      }
      this.lastHealthCheckAt.set(worker.worker_id, Date.now());

      const adapter = this.adapterRegistry.getAdapter(worker.worker_id);
      if (!adapter) {
        await this.publishOnce(eventBus, `worker:${worker.worker_id}:missing_adapter`, 60_000, EventType.WORKER_HEALTH_CHECKED, {
          worker_id: worker.worker_id,
          ok: false,
          message: `No adapter registered for worker ${worker.worker_id}`,
          checked_at: nowIso()
        }, {
          worker_id: worker.worker_id
        });
        continue;
      }

      try {
        const health = await adapter.healthCheck(worker.worker_id);
        await eventBus.publish(createEvent(EventType.WORKER_HEALTH_CHECKED, {
          worker_id: worker.worker_id,
          ok: health.ok,
          message: health.message,
          checked_at: nowIso()
        }, {
          worker_id: worker.worker_id
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.publishOnce(eventBus, `worker:${worker.worker_id}:health_error:${message}`, 60_000, EventType.WORKER_HEALTH_CHECKED, {
          worker_id: worker.worker_id,
          ok: false,
          message,
          checked_at: nowIso()
        }, {
          worker_id: worker.worker_id
        });
      }
    }
  }

  private async checkExecutions(eventBus: EventBus, settings: Settings): Promise<void> {
    const executions = await this.repositories.executions.list();
    const activeExecutions = executions.filter((item) =>
      item.state === ExecutionState.RUNNING ||
      item.state === ExecutionState.QUEUED ||
      item.state === ExecutionState.VERIFYING
    );

    for (const execution of activeExecutions) {
      const adapter = this.adapterRegistry.getExecutionAdapter(execution.execution_id);
      if (!adapter) {
        if (execution.state !== ExecutionState.QUEUED) {
          await this.publishOpsAlertOnce(eventBus, execution, "EXECUTION_ADAPTER_MISSING", `No execution adapter registered for ${execution.execution_id}`);
        }
        continue;
      }

      try {
        const heartbeat = await adapter.pollStatus(execution.execution_id);
        if (heartbeat) {
          await eventBus.publish(
            createEvent(
              EventType.WORKER_HEARTBEAT_RECEIVED,
              { heartbeat },
              {
                demand_id: execution.demand_id,
                subgoal_id: execution.subgoal_id,
                execution_id: execution.execution_id,
                worker_id: execution.worker_id
              }
            )
          );
        }

        const result = await adapter.collectResult(execution.execution_id);
        if (result) {
          await eventBus.publish(
            createEvent(
              EventType.WORKER_RESULT_RECEIVED,
              { worker_result: result },
              {
                demand_id: execution.demand_id,
                subgoal_id: execution.subgoal_id,
                execution_id: execution.execution_id,
                worker_id: execution.worker_id
              }
            )
          );
          continue;
        }

        const timeoutReason = this.detectTimeout(execution, settings);
        if (timeoutReason) {
          await this.publishOnce(eventBus, `execution:${execution.execution_id}:timeout:${timeoutReason}`, 60_000, EventType.EXECUTION_TIMEOUT_DETECTED, {
            timeout_seconds: settings.runtime.execution_timeout_seconds,
            heartbeat_interval_seconds: settings.runtime.heartbeat_interval_seconds,
            last_heartbeat_at: execution.last_heartbeat_at,
            reason: timeoutReason
          }, {
            demand_id: execution.demand_id,
            subgoal_id: execution.subgoal_id,
            execution_id: execution.execution_id,
            worker_id: execution.worker_id
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await eventBus.publish(
          createEvent(
            EventType.WORKER_RESULT_RECEIVED,
            {
              worker_result: createWorkerFailureResult({
                executionId: execution.execution_id,
                workerId: execution.worker_id,
                code: "WORKER_RUNTIME_ERROR",
                message,
                startedAt: execution.started_at,
                suggestedNextStep: "Inspect worker adapter status polling and retry or request human decision"
              })
            },
            {
              demand_id: execution.demand_id,
              subgoal_id: execution.subgoal_id,
              execution_id: execution.execution_id,
              worker_id: execution.worker_id
            }
          )
        );
      }
    }
  }

  private detectTimeout(execution: Execution, settings: Settings): TimeoutReason | null {
    const now = Date.now();
    const timeoutMs = settings.runtime.execution_timeout_seconds * 1000;
    const heartbeatMs = settings.runtime.heartbeat_interval_seconds * 1000;

    if (execution.started_at && now - new Date(execution.started_at).getTime() > timeoutMs) {
      return "execution_budget_exceeded";
    }

    if (execution.last_heartbeat_at && now - new Date(execution.last_heartbeat_at).getTime() > Math.max(heartbeatMs * 2, 10_000)) {
      return "heartbeat_missing";
    }

    if (!execution.started_at && now - new Date(execution.created_at).getTime() > timeoutMs) {
      return "wall_clock_timeout";
    }

    return null;
  }

  private async publishOpsAlertOnce(
    eventBus: EventBus,
    execution: Execution,
    code: string,
    message: string
  ): Promise<void> {
    await this.publishOnce(eventBus, `execution:${execution.execution_id}:alert:${code}`, 60_000, EventType.OPS_ALERT, {
      code,
      message,
      severity: "error",
      details: {
        execution_id: execution.execution_id,
        worker_id: execution.worker_id
      }
    }, {
      demand_id: execution.demand_id,
      subgoal_id: execution.subgoal_id,
      execution_id: execution.execution_id,
      worker_id: execution.worker_id
    });
  }

  private async publishOnce<T extends EventType>(
    eventBus: EventBus,
    key: string,
    cooldownMs: number,
    eventType: T,
    payload: any,
    refs: any
  ): Promise<void> {
    const lastEmittedAt = this.emittedIncidentAt.get(key) ?? 0;
    if (Date.now() - lastEmittedAt < cooldownMs) {
      return;
    }
    this.emittedIncidentAt.set(key, Date.now());
    await eventBus.publish(createEvent(eventType, payload, refs));
  }
}
