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
  DemandState,
  EventType,
  Execution,
  ExecutionState,
  Settings,
  SubgoalState,
  nowIso
} from "../../domain/index.js";
import { EventBus } from "../scheduler/event_bus/eventBus.js";
import { createWorkerFailureResult } from "../scheduler/handlers/executionRuntime.js";
import { createLogger } from "../../logger.js";
import { RepositoryBundle } from "../store/repositories/index.js";
import { AdapterRegistry } from "../../worker/adapters/registry.js";

const logger = createLogger("ops_monitor");

type TimeoutReason = "heartbeat_missing" | "execution_budget_exceeded" | "wall_clock_timeout";

// 卡死 demand 巡检的几个安全阈值。提取出来集中调，便于运维理解和回归。
const STUCK_DEMAND_QUIET_MS = 60_000;        // demand updated_at 距今 > 60s 才视作"卡死"，避免误抓正在推进的事件链
const STUCK_DEMAND_COOLDOWN_MS = 300_000;    // 同一 demand 自愈触发后 5 分钟内不再触发，避免死循环放大问题
const OPS_COLD_START_GRACE_MS = 30_000;      // server 启动后 30s 内不做卡死判定（数据加载 / adapter 注册可能未稳）

export class OpsMonitor {
  private readonly emittedIncidentAt = new Map<string, number>();
  private readonly lastHealthCheckAt = new Map<string, number>();
  private readonly serviceStartedAt = Date.now();

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
        await this.checkStuckDemands(eventBus);
      } catch (error) {
        logger.error({ err: error }, "Ops monitor tick failed");
      }
    }, 2000);
  }

  /**
   * 函数作用：扫描所有 ACTIVE demand，识别"事件孤儿 / 状态机停滞"，自动 publish REPLAN_REQUESTED 把它们重新激活。
   *
   * 触发场景（用户测试时遇到的真实案例）：
   * EventBus.publish 先把事件持久化到 events.json，再调 handler。两步之间没有事务，
   * 任何 server 进程在这中间被 kill / 重启都会导致那条事件成为"孤儿"。重启后没有事件回放机制，
   * demand 就永远卡在某个 ACTIVE-but-idle 状态。
   *
   * 卡死判定（要全部满足）：
   *   1. demand.state === ACTIVE
   *   2. 不在等用户输入（waiting_on === null）
   *   3. 没有活跃决策（active_decision_id === null）
   *   4. 没有 RUNNING / QUEUED / WAITING_RESULT / VERIFYING 状态的 execution
   *   5. 没有 READY / DISPATCHED / EXECUTING / VERIFYING 状态的 subgoal（如果有 READY，正常调度器会推进，不该兜底）
   *   6. demand.updated_at 距今 > STUCK_DEMAND_QUIET_MS（避免误抓正在快速推进的链路）
   *
   * 自愈动作：publish REPLAN_REQUESTED(reason="resume")，由 planner 决定下一步。
   * 不直接改 subgoal / demand 状态 —— 把"决定"交给 planner 更安全。
   *
   * 安全门：
   *   - server 启动后 OPS_COLD_START_GRACE_MS 内不动手（数据加载 / adapter 注册可能未稳）
   *   - 每个 demand 触发自愈后 STUCK_DEMAND_COOLDOWN_MS 内不再触发（publishOnce 提供）
   */
  private async checkStuckDemands(eventBus: EventBus): Promise<void> {
    if (Date.now() - this.serviceStartedAt < OPS_COLD_START_GRACE_MS) {
      return;
    }

    const demands = await this.repositories.demands.list();
    const candidates = demands.filter((demand) => {
      if (demand.state !== DemandState.ACTIVE) return false;
      if (demand.active_decision_id) return false;
      const runtimeSession = demand.metadata?.runtime_session as { waiting_on?: string | null } | undefined;
      if (runtimeSession?.waiting_on) return false;
      const updatedAt = new Date(demand.updated_at).getTime();
      if (!Number.isFinite(updatedAt)) return false;
      if (Date.now() - updatedAt < STUCK_DEMAND_QUIET_MS) return false;
      return true;
    });

    if (candidates.length === 0) {
      return;
    }

    const allExecutions = await this.repositories.executions.list();
    const allSubgoals = await this.repositories.subgoals.list();

    const liveExecutionStates = new Set<ExecutionState>([
      ExecutionState.QUEUED,
      ExecutionState.RUNNING,
      ExecutionState.WAITING_RESULT,
      ExecutionState.VERIFYING
    ]);
    const liveSubgoalStates = new Set<SubgoalState>([
      SubgoalState.READY,
      SubgoalState.DISPATCHED,
      SubgoalState.EXECUTING,
      SubgoalState.VERIFYING
    ]);

    for (const demand of candidates) {
      const hasLiveExecution = allExecutions.some(
        (exec) => exec.demand_id === demand.demand_id && liveExecutionStates.has(exec.state)
      );
      if (hasLiveExecution) continue;
      const hasLiveSubgoal = allSubgoals.some(
        (sg) => sg.demand_id === demand.demand_id && liveSubgoalStates.has(sg.state)
      );
      if (hasLiveSubgoal) continue;

      logger.warn({
        demandId: demand.demand_id,
        demandTitle: demand.title,
        updatedAt: demand.updated_at,
        idleSeconds: Math.floor((Date.now() - new Date(demand.updated_at).getTime()) / 1000)
      }, "检测到卡死 demand —— 自愈触发 REPLAN_REQUESTED(reason=resume)");

      await this.publishOnce(
        eventBus,
        `stuck-demand:${demand.demand_id}`,
        STUCK_DEMAND_COOLDOWN_MS,
        EventType.REPLAN_REQUESTED,
        { reason: "resume" },
        { demand_id: demand.demand_id }
      );
    }
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

        if (execution.state !== ExecutionState.VERIFYING) {
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
        if (execution.state === ExecutionState.VERIFYING) {
          logger.warn({ err: error, executionId: execution.execution_id }, "Ignoring worker polling error while execution is verifying");
          continue;
        }
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
