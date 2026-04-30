import {
  createEvent,
  DemandPhase,
  DemandState,
  EventType,
  HandlerResult,
  SchedulerEvent,
  SubgoalState
} from "../../domain/index.js";
import { HandlerContext } from "../../event_bus/types.js";
import { createLogger } from "../../logger.js";
import {
  isTerminalDemand,
  transitionDemand,
  transitionSubgoal
} from "../stateMachine.js";
import { isSubgoalUnlockedByPlan } from "../planProgress.js";
import { demandHasActiveExecutions } from "../executionRuntime.js";

const logger = createLogger("handlers:planning");

export async function onReplanRequested(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (!demand || !demand.operational_objective) {
    logger.warn({ demandId: event.demand_id }, "忽略重新规划请求，因为未找到需求或操作目标");
    return {};
  }
  if (isTerminalDemand(demand) || demand.state === DemandState.PAUSED) {
    logger.debug({ demandId: demand.demand_id, state: demand.state }, "忽略重新规划请求，因为需求当前不可调度");
    return {};
  }

  const settings = await ctx.repositories.loadSettings();
  const planningRound = (await ctx.repositories.subgoals.list()).filter((item) => item.demand_id === demand.demand_id).length + 1;
  const reason = (event.payload as { reason: "initial_plan" | "replan_after_result" | "replan_after_decision" | "resume" }).reason;
  logger.info({ demandId: demand.demand_id, planningRound, reason }, "正在生成前沿计划");
  const plan = await ctx.planner.generateFrontierPlan(
    demand,
    reason,
    planningRound,
    settings
  );
  logger.info({ demandId: demand.demand_id, planningRound, subgoalCount: plan.subgoals.length }, "前沿计划已生成");
  return {
    events: [
      createEvent(EventType.PLAN_GENERATED, plan.payload, { demand_id: demand.demand_id }),
      ...plan.subgoals.map((subgoal) => createEvent(
        EventType.SUBGOAL_CREATED,
        { subgoal_contract: subgoal, planning_round: planningRound, source: "planner" },
        { demand_id: demand.demand_id, subgoal_id: subgoal.subgoal_id }
      ))
    ]
  };
}

export async function onPlanGenerated(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (!demand) {
    logger.warn({ demandId: event.demand_id }, "忽略已生成计划，因为未找到对应需求");
    return {};
  }

  const frontierSubgoalIds = (event.payload as { frontier_subgoal_ids?: string[] }).frontier_subgoal_ids ?? [];
  await ctx.repositories.demands.upsert(transitionDemand(demand, {
    metadata: {
      ...(demand.metadata ?? {}),
      latest_plan: event.payload
    }
  }, {
    phase: DemandPhase.PLANNING,
    frontier_subgoal_ids: frontierSubgoalIds,
    progress_note: "Frontier plan generated"
  }));

  logger.info({ demandId: demand.demand_id, frontierSubgoalCount: frontierSubgoalIds.length }, "已将生成计划保存到需求");
  return {};
}

export async function onSubgoalCreated(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const payload = event.payload as { subgoal_contract: any };
  await ctx.repositories.subgoals.upsert(payload.subgoal_contract);
  logger.info({ demandId: event.demand_id, subgoalId: payload.subgoal_contract.subgoal_id }, "子目标已创建");

  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (!demand) {
    logger.warn({ demandId: event.demand_id, subgoalId: payload.subgoal_contract.subgoal_id }, "子目标已创建，但未找到对应需求");
    return {};
  }
  if (isTerminalDemand(demand) || demand.state === DemandState.PAUSED) {
    logger.debug({ demandId: demand.demand_id, state: demand.state, subgoalId: payload.subgoal_contract.subgoal_id }, "子目标暂不标记为就绪，因为需求当前不可调度");
    return {};
  }

  const demandSubgoals = (await ctx.repositories.subgoals.list()).filter((item) => item.demand_id === demand.demand_id);
  const shouldUnlock = isSubgoalUnlockedByPlan(demand, payload.subgoal_contract.subgoal_id, demandSubgoals);
  if (!shouldUnlock) {
    logger.debug({ demandId: demand.demand_id, subgoalId: payload.subgoal_contract.subgoal_id }, "子目标保持计划中，因为前置计划项尚未完成");
    return {};
  }

  logger.info({ demandId: demand.demand_id, subgoalId: payload.subgoal_contract.subgoal_id }, "子目标已解锁，准备标记为就绪");
  return {
    events: [
      createEvent(
        EventType.SUBGOAL_MARKED_READY,
        {
          dependency_check: {
            satisfied_dependencies: [],
            remaining_dependencies: []
          }
        },
        {
          demand_id: event.demand_id,
          subgoal_id: payload.subgoal_contract.subgoal_id
        }
      )
    ]
  };
}

export async function onSubgoalMarkedReady(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  const subgoal = await ctx.repositories.subgoals.getById(event.subgoal_id ?? "");
  const workers = await ctx.repositories.workers.list();
  const settings = await ctx.repositories.loadSettings();
  if (!demand || !subgoal) {
    logger.warn({ demandId: event.demand_id, subgoalId: event.subgoal_id }, "忽略就绪标记，因为未找到需求或子目标");
    return {};
  }
  if (isTerminalDemand(demand) || demand.state === DemandState.PAUSED) {
    logger.debug({ demandId: demand.demand_id, state: demand.state, subgoalId: subgoal.subgoal_id }, "忽略就绪标记，因为需求当前不可调度");
    return {};
  }
  if (![SubgoalState.PLANNED, SubgoalState.BLOCKED].includes(subgoal.state)) {
    logger.debug({ demandId: demand.demand_id, subgoalId: subgoal.subgoal_id, state: subgoal.state }, "忽略就绪标记，因为子目标不是计划中或阻塞状态");
    return {};
  }

  const readySubgoal = transitionSubgoal(subgoal, { state: SubgoalState.READY });
  await ctx.repositories.subgoals.upsert(readySubgoal);
  logger.info({ demandId: demand.demand_id, subgoalId: subgoal.subgoal_id }, "子目标已标记为就绪");

  const worker = ctx.dispatcher.selectWorker(workers, readySubgoal);
  if (!worker) {
    if (await demandHasActiveExecutions(demand.demand_id, ctx)) {
      logger.info({ demandId: demand.demand_id, subgoalId: subgoal.subgoal_id }, "暂无可用工作器，等待活跃执行结束后再请求决策");
      return {};
    }
    logger.warn({ demandId: demand.demand_id, subgoalId: subgoal.subgoal_id }, "就绪子目标暂无可用工作器，准备请求用户决策");
    const prompt = await ctx.decisionService.buildPrompt({
      demand,
      settings,
      source: "scheduler",
      reasonCode: "BLOCKED" as any,
      fallbackPrompt: "No available worker matched the frontier subgoal"
    });
    const decision = ctx.decisionService.createRequest({
      demandId: demand.demand_id,
      source: "scheduler",
      reasonCode: "BLOCKED" as any,
      prompt,
      subgoalId: subgoal.subgoal_id
    });
    return {
      events: [
        createEvent(EventType.DECISION_REQUEST_CREATED, { decision_request: decision }, {
          demand_id: demand.demand_id,
          subgoal_id: subgoal.subgoal_id,
          decision_id: decision.decision_id
        })
      ]
    };
  }

  const execution = ctx.dispatcher.buildExecution({ demand, subgoal: readySubgoal, worker });
  const packet = ctx.dispatcher.buildPacket({
    demand,
    subgoal: readySubgoal,
    execution,
    worker,
    workspaceRoot: settings.workspace_root,
    heartbeatSeconds: settings.runtime.heartbeat_interval_seconds,
    timeoutSeconds: settings.runtime.execution_timeout_seconds
  });

  logger.info({ demandId: demand.demand_id, subgoalId: subgoal.subgoal_id, executionId: execution.execution_id, workerId: worker.worker_id }, "已为就绪子目标创建执行");
  return {
    events: [
      createEvent(EventType.EXECUTION_CREATED, { execution, dispatch_packet: packet }, {
        demand_id: demand.demand_id,
        subgoal_id: subgoal.subgoal_id,
        execution_id: execution.execution_id,
        worker_id: worker.worker_id
      })
    ]
  };
}
