/**
 * 文件名称：routes.ts
 * 文件作用：HTTP 接口路由模块，负责声明 REST API 路径并将请求转交给领域服务和事件总线。
 *
 * 主要职责：
 * 1. 定义需求、子目标、执行、工作器、设置和决策相关接口。
 * 2. 将用户操作转换为领域事件或仓储读写。
 * 3. 统一 HTTP 响应格式和常见错误处理。
 *
 * 依赖模块：
 * - express：HTTP 路由框架。
 * - brain/store/repositories：数据仓储集合。
 * - brain/scheduler/event_bus：调度事件发布入口。
 * - worker/adapters/registry：工作器适配器注册表。
 *
 * 注意事项：
 * - 路由层不应承载复杂业务流程，复杂状态推进应交由事件处理器完成。
 * - 新增接口时应保持路径、响应结构和事件语义一致。
 */
import express from "express";

import { createEvent, createId, DecisionAction, DemandState, EventType, ExecutionState, SubgoalState, nowIso, WorkerRegistryStatus } from "../../domain/index.js";
import { EventBus } from "../../brain/scheduler/event_bus/index.js";
import { RepositoryBundle } from "../../brain/store/repositories/index.js";
import { AdapterRegistry } from "../../worker/adapters/registry.js";
import { deriveSessionFromDemand, withRuntimeSessionMetadata } from "../../brain/scheduler/handlers/sessionState.js";

/**
 * 函数作用：创建后端 HTTP API 路由。
 *
 * 参数说明：
 * - repositories：领域数据仓储集合。
 * - eventBus：调度事件发布入口。
 * - adapterRegistry：工作器适配器注册表。
 *
 * 返回值：
 * - express.Router：已挂载需求、执行、工作器、设置和决策相关接口的路由实例。
 *
 * 注意事项：
 * - 路由处理应尽量把状态推进转换为事件发布，复杂流程交给事件处理器。
 */
export function createApiRouter(
  repositories: RepositoryBundle,
  eventBus: EventBus,
  adapterRegistry: AdapterRegistry
): express.Router {
  const router = express.Router();
  const subgoalPriorityOrder: Record<string, number> = {
    [SubgoalState.EXECUTING]: 0,
    [SubgoalState.VERIFYING]: 1,
    [SubgoalState.DISPATCHED]: 2,
    [SubgoalState.READY]: 3,
    [SubgoalState.PLANNED]: 4,
    [SubgoalState.BLOCKED]: 5,
    [SubgoalState.DONE]: 6,
    [SubgoalState.FAILED]: 7,
    [SubgoalState.CANCELLED]: 8
  };

  router.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  router.post("/demands", async (req, res, next) => {
    try {
      const demandId = createId("demand");
      await eventBus.publish(
        createEvent(
          EventType.USER_INPUT_RECEIVED,
          {
            input_text: String(req.body.initial_input ?? ""),
            input_kind: "initial_demand",
            source: "ui",
            session_tag: null
          },
          { demand_id: demandId }
        )
      );

      const demand = await repositories.demands.getById(demandId);
      const session = demand
        ? await repositories.sessions.getById(`session_${demand.demand_id}`)
        : null;
      res.status(201).json(demand && session ? withRuntimeSessionMetadata(demand, session) : demand);
    } catch (error) {
      next(error);
    }
  });

  router.get("/demands", async (_req, res, next) => {
    try {
      const [demands, sessions, subgoals, executions] = await Promise.all([
        repositories.demands.list(),
        repositories.sessions.list(),
        repositories.subgoals.list(),
        repositories.executions.list()
      ]);
      const sessionsByDemandId = new Map(sessions.map((session) => [session.demand_id, session]));

      res.json(
        demands
          .filter((demand) => demand.state !== DemandState.CANCELLED)
          .map((demand) => {
            const session = sessionsByDemandId.get(demand.demand_id) ?? deriveSessionFromDemand(demand);
            const demandSubgoals = subgoals
              .filter((item) => item.demand_id === demand.demand_id)
              .sort((left, right) => {
                const leftRank = subgoalPriorityOrder[left.state] ?? 99;
                const rightRank = subgoalPriorityOrder[right.state] ?? 99;
                if (leftRank !== rightRank) {
                  return leftRank - rightRank;
                }
                return left.priority - right.priority;
              });

            const activeWorkerIds = new Set(
              executions
                .filter((item) =>
                  item.demand_id === demand.demand_id &&
                  ![ExecutionState.DONE, ExecutionState.FAILED, ExecutionState.CANCELLED, ExecutionState.TIMEOUT, ExecutionState.INTERRUPTED].includes(item.state)
                )
                .map((item) => item.worker_id)
            );

            return {
              ...withRuntimeSessionMetadata(demand, session),
              dashboard_summary: {
                current_subgoal_title: demandSubgoals[0]?.title ?? null,
                worker_count: activeWorkerIds.size
              }
            };
          })
      );
    } catch (error) {
      next(error);
    }
  });

  router.get("/demands/:id", async (req, res, next) => {
    try {
      const demand = await repositories.demands.getById(req.params.id);
      if (!demand) {
        res.status(404).json({ error: "Demand not found" });
        return;
      }

      const [session, subgoals, executions, decisions, memory, events] = await Promise.all([
        repositories.sessions.getById(`session_${demand.demand_id}`),
        repositories.subgoals.list(),
        repositories.executions.list(),
        repositories.decisions.list(),
        repositories.memory.list(),
        repositories.events.list()
      ]);

      const demandSession = session ?? deriveSessionFromDemand(demand);

      res.json({
        demand: withRuntimeSessionMetadata(demand, demandSession),
        session: demandSession,
        subgoals: subgoals.filter((item) => item.demand_id === demand.demand_id),
        executions: executions.filter((item) => item.demand_id === demand.demand_id),
        decisions: decisions.filter((item) => item.demand_id === demand.demand_id),
        memory: memory.filter((item) => item.demand_id === demand.demand_id),
        events: events.filter((item) => item.demand_id === demand.demand_id)
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/demands/:id", async (req, res, next) => {
    try {
      const demandId = req.params.id;
      const demand = await repositories.demands.getById(demandId);
      if (!demand) {
        res.status(404).json({ error: "Demand not found" });
        return;
      }

      const [sessions, subgoals, executions, decisions, memory, events, workers] = await Promise.all([
        repositories.sessions.list(),
        repositories.subgoals.list(),
        repositories.executions.list(),
        repositories.decisions.list(),
        repositories.memory.list(),
        repositories.events.list(),
        repositories.workers.list()
      ]);

      const executionIdsToDelete = new Set(
        executions
          .filter((item) => item.demand_id === demandId)
          .map((item) => item.execution_id)
      );

      const nextWorkers = workers.map((worker) => {
        const nextExecutionIds = worker.current_execution_ids.filter((executionId) => !executionIdsToDelete.has(executionId));
        return {
          ...worker,
          current_execution_ids: nextExecutionIds,
          status: nextExecutionIds.length > 0 ? worker.status : WorkerRegistryStatus.IDLE,
          updated_at: nowIso()
        };
      });

      await Promise.all([
        repositories.demands.delete(demandId),
        repositories.sessions.saveAll(sessions.filter((item) => item.demand_id !== demandId)),
        repositories.subgoals.saveAll(subgoals.filter((item) => item.demand_id !== demandId)),
        repositories.executions.saveAll(executions.filter((item) => item.demand_id !== demandId)),
        repositories.decisions.saveAll(decisions.filter((item) => item.demand_id !== demandId)),
        repositories.memory.saveAll(memory.filter((item) => item.demand_id !== demandId)),
        repositories.events.saveAll(events.filter((item) => item.demand_id !== demandId)),
        repositories.workers.saveAll(nextWorkers)
      ]);

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.post("/demands/:id/messages", async (req, res, next) => {
    try {
      await eventBus.publish(
        createEvent(
          EventType.USER_INPUT_RECEIVED,
          {
            input_text: String(req.body.input_text ?? ""),
            input_kind: "clarification_reply",
            source: "ui",
            session_tag: null
          },
          { demand_id: req.params.id }
        )
      );
      res.status(202).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post("/demands/:id/replan", async (req, res, next) => {
    try {
      const demand = await repositories.demands.getById(req.params.id);
      if (!demand) {
        res.status(404).json({ error: "Demand not found" });
        return;
      }
      const terminalStates = [DemandState.COMPLETED, DemandState.FAILED, DemandState.CANCELLED];
      if (terminalStates.includes(demand.state) || demand.state === DemandState.PAUSED) {
        res.status(409).json({ error: `Demand state ${demand.state} is not replannable` });
        return;
      }
      const rawNote = typeof req.body?.note === "string" ? req.body.note.trim() : "";
      await eventBus.publish(
        createEvent(
          EventType.REPLAN_REQUESTED,
          {
            reason: "user_triggered",
            note: rawNote.length > 0 ? rawNote : null,
            source: "ui"
          },
          { demand_id: demand.demand_id }
        )
      );
      res.status(202).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post("/demands/:id/control", async (req, res, next) => {
    try {
      const action = String(req.body.action ?? "");
      const eventType = action === "pause"
        ? EventType.DEMAND_PAUSED
        : action === "resume"
          ? EventType.DEMAND_RESUMED
          : EventType.DEMAND_CANCELLED;
      await eventBus.publish(
        createEvent(
          eventType,
          { action: action as "pause" | "resume" | "cancel", note: req.body.note as string | undefined },
          { demand_id: req.params.id }
        )
      );
      res.status(202).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post("/decisions/:id/respond", async (req, res, next) => {
    try {
      const decision = await repositories.decisions.getById(req.params.id);
      if (!decision) {
        res.status(404).json({ error: "Decision not found" });
        return;
      }

      await eventBus.publish(
        createEvent(
          EventType.DECISION_RESPONSE_RECEIVED,
          {
            decision_response: {
              schema_version: "v1",
              decision_id: decision.decision_id,
              action: (req.body.action as DecisionAction) ?? DecisionAction.PROVIDE_INFO,
              note: req.body.note ?? null,
              payload: req.body.payload ?? {},
              responded_at: nowIso()
            }
          },
          {
            decision_id: decision.decision_id,
            demand_id: decision.demand_id,
            subgoal_id: decision.subgoal_id ?? null,
            execution_id: decision.execution_id ?? null
          }
        )
      );
      res.status(202).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post("/executions/:id/interrupt", async (req, res, next) => {
    try {
      const execution = await repositories.executions.getById(req.params.id);
      if (!execution) {
        res.status(404).json({ error: "Execution not found" });
        return;
      }
      if (![ExecutionState.RUNNING, ExecutionState.QUEUED].includes(execution.state)) {
        res.status(409).json({ error: `Execution is not active (state: ${execution.state})` });
        return;
      }
      await eventBus.publish(
        createEvent(
          EventType.EXECUTION_STOP_REQUESTED,
          { reason: "user_interrupted", note: req.body.note ?? null },
          {
            demand_id: execution.demand_id,
            subgoal_id: execution.subgoal_id,
            execution_id: execution.execution_id,
            worker_id: execution.worker_id
          }
        )
      );
      res.status(202).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.get("/workers", async (_req, res, next) => {
    try {
      res.json(await repositories.workers.list());
    } catch (error) {
      next(error);
    }
  });

  router.post("/workers/register", async (req, res, next) => {
    try {
      const timestamp = nowIso();
      const worker = {
        worker_id: req.body.worker_id ?? createId("worker"),
        name: String(req.body.name ?? "worker"),
        adapter_type: req.body.adapter_type as "codex" | "opencode",
        runtime_type: (req.body.runtime_type as "local_command" | "http" | "websocket") ?? "local_command",
        status: WorkerRegistryStatus.IDLE,
        max_concurrency: Number(req.body.max_concurrency ?? 1),
        capabilities: req.body.capabilities ?? ["code_generation", "file_edit", "command_execution"],
        available_skills: req.body.available_skills ?? [],
        install_policy: "allowed_with_review" as const,
        config: req.body.config,
        current_execution_ids: [],
        last_seen_at: null,
        last_error: null,
        is_enabled: true,
        created_at: timestamp,
        updated_at: timestamp
      };
      await repositories.workers.upsert(worker);
      const adapter = adapterRegistry.getAdapter(worker.worker_id);
      await adapter?.register(worker);
      res.status(201).json(worker);
    } catch (error) {
      next(error);
    }
  });

  router.get("/settings", async (_req, res, next) => {
    try {
      res.json(await repositories.loadSettings());
    } catch (error) {
      next(error);
    }
  });

  router.put("/settings", async (req, res, next) => {
    try {
      const settings = await repositories.loadSettings();
      const nextSettings = {
        ...settings,
        ...req.body,
        models: {
          ...settings.models,
          ...(req.body.models ?? {}),
          primary: {
            ...settings.models.primary,
            ...(req.body.models?.primary ?? {})
          },
          planner: {
            ...settings.models.planner,
            ...(req.body.models?.planner ?? {})
          },
          verifier: {
            ...settings.models.verifier,
            ...(req.body.models?.verifier ?? {})
          },
          ops_backup: {
            ...settings.models.ops_backup,
            ...(req.body.models?.ops_backup ?? {})
          }
        },
        runtime: {
          ...settings.runtime,
          ...(req.body.runtime ?? {})
        },
        worker_policy: {
          ...settings.worker_policy,
          ...(req.body.worker_policy ?? {})
        },
        default_permissions: {
          ...settings.default_permissions,
          ...(req.body.default_permissions ?? {})
        },
        updated_at: nowIso()
      };
      await repositories.settings.save(nextSettings);
      res.json(nextSettings);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
