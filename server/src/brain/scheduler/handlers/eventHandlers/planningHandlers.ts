/**
 * 文件名称：planningHandlers.ts
 * 文件作用：规划事件处理器模块，负责处理重规划、计划生成、子目标创建和子目标就绪事件。
 *
 * 主要职责：
 * 1. 根据需求和执行反馈触发规划服务生成新计划。
 * 2. 将计划结果写入需求和子目标仓储。
 * 3. 根据依赖关系解锁可执行子目标。
 * 4. 为就绪子目标创建执行记录并发布执行事件。
 *
 * 依赖模块：
 * - domain：需求、子目标、执行和事件类型。
 * - event_bus/types：处理器上下文。
 * - planProgress：计划依赖解锁判断。
 * - executionRuntime：活跃执行判断。
 *
 * 注意事项：
 * - 计划与子目标创建应保持幂等，避免重复创建同一计划项。
 * - 子目标解锁逻辑必须与计划大纲中的依赖顺序一致。
 */
import {
  createEvent,
  DecisionAction,
  DecisionReasonCode,
  DemandPhase,
  DemandState,
  EventReason,
  EventType,
  HandlerResult,
  PlanGeneratedPayload,
  SchedulerEvent,
  SubgoalState
} from "../../../../domain/index.js";
import { HandlerContext } from "../../event_bus/types.js";
import { createLogger } from "../../../../logger.js";
import { ReplanRuntimeContext } from "../../../engines/planner/service.js";
import { collectWorkspaceGrants } from "../../../dispatch/dispatcher/service.js";
import {
  isTerminalDemand,
  transitionDemand,
  transitionSubgoal
} from "../stateMachine.js";
import { isSubgoalUnlockedByPlan } from "../planProgress.js";
import { demandHasActiveExecutions } from "../executionRuntime.js";

const logger = createLogger("handlers:planning");

function summarizeEvent(event: SchedulerEvent): NonNullable<ReplanRuntimeContext["recent_events"]>[number] {
  const payload = event.payload as Record<string, unknown>;
  const workerResult = payload.worker_result as Record<string, unknown> | undefined;
  const verificationResult = payload.verification_result as Record<string, unknown> | undefined;
  const decisionRequest = payload.decision_request as Record<string, unknown> | undefined;
  const decisionResponse = payload.decision_response as Record<string, unknown> | undefined;
  const summary: Record<string, unknown> = {};

  if (workerResult) {
    summary.worker_status = workerResult.worker_status;
    summary.claimed_outcome = workerResult.claimed_outcome;
    summary.blocker_reason = workerResult.blocker_reason;
    summary.suggested_next_step = workerResult.suggested_next_step;
  }
  if (verificationResult) {
    summary.verified_status = verificationResult.verified_status;
    summary.notes = verificationResult.notes;
  }
  if (decisionRequest) {
    summary.reason_code = decisionRequest.reason_code;
    summary.status = decisionRequest.status;
  }
  if (decisionResponse) {
    summary.action = decisionResponse.action;
    summary.note = decisionResponse.note;
  }
  if (typeof payload.reason === "string") {
    summary.reason = payload.reason;
  }
  if (typeof payload.summary === "string") {
    summary.summary = payload.summary;
  }

  return {
    event_type: event.event_type,
    created_at: event.created_at,
    subgoal_id: event.subgoal_id,
    execution_id: event.execution_id,
    decision_id: event.decision_id,
    summary: Object.keys(summary).length > 0 ? summary : undefined
  };
}

async function buildReplanRuntimeContext(demandId: string, ctx: HandlerContext): Promise<ReplanRuntimeContext> {
  const [session, events, executions, memory] = await Promise.all([
    ctx.repositories.sessions.getById(`session_${demandId}`),
    ctx.repositories.events.list(),
    ctx.repositories.executions.list(),
    ctx.repositories.memory.list()
  ]);

  return {
    session: session ?? null,
    recent_events: events
      .filter((item) => item.demand_id === demandId)
      .sort((left, right) => left.created_at.localeCompare(right.created_at))
      .slice(-20)
      .map(summarizeEvent),
    recent_executions: executions
      .filter((item) => item.demand_id === demandId)
      .sort((left, right) => left.updated_at.localeCompare(right.updated_at))
      .slice(-10)
      .map((execution) => ({
        execution_id: execution.execution_id,
        subgoal_id: execution.subgoal_id,
        state: execution.state,
        result_status: execution.result_status,
        claimed_outcome: execution.claimed_outcome,
        updated_at: execution.updated_at
      })),
    recent_memory: memory
      .filter((item) => item.demand_id === demandId)
      .sort((left, right) => (left.created_at ?? "").localeCompare(right.created_at ?? ""))
      .slice(-8)
      .map((item) => ({
        category: item.category,
        content: item.content,
        created_at: item.created_at
      }))
  };
}

/**
 * 函数作用：处理重规划请求并调用规划服务生成新计划。
 *
 * 参数说明：
 * - event：重规划请求事件。
 * - ctx：事件处理器上下文。
 *
 * 返回值：
 * - Promise<HandlerResult>：计划生成事件发布结果。
 */
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
  const reason = (event.payload as { reason: EventReason }).reason;
  const runtimeContext = await buildReplanRuntimeContext(demand.demand_id, ctx);
  logger.info({
    demandId: demand.demand_id,
    planningRound,
    reason,
    sessionId: runtimeContext.session?.session_id,
    recentEventCount: runtimeContext.recent_events?.length ?? 0
  }, "正在生成前沿计划");
  const plan = await ctx.planner.generateFrontierPlan(
    demand,
    reason,
    planningRound,
    settings,
    runtimeContext
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

/**
 * 函数作用：处理计划生成事件并创建对应子目标。
 *
 * 参数说明：
 * - event：计划生成事件。
 * - ctx：事件处理器上下文。
 *
 * 返回值：
 * - Promise<HandlerResult>：子目标创建和需求元数据更新结果。
 */
// 哪些 plan 来源需要弹出人类审核：
// - initial_plan: 首次出方案，必审
// - user_triggered: 用户在 UI 主动点 Replan 触发的
// - replan_after_decision: 用户在面板提反馈后触发的新一轮
// - recon_completed: planner 派了 recon 子目标探完后生成的"真正方案"
// 跳过审核：replan_after_result（worker 报 PARTIAL 自动 replan）；resume（恢复执行，原方案没变）
const REASONS_REQUIRING_PLAN_REVIEW: ReadonlySet<EventReason> = new Set<EventReason>([
  "initial_plan",
  "user_triggered",
  "replan_after_decision",
  "recon_completed"
]);

function buildPlanReviewPrompt(payload: PlanGeneratedPayload, demandTitle: string): string {
  const outlineLines = payload.overall_plan_outline.slice(0, 8).map((item, index) =>
    `  ${index + 1}. ${item.title} — ${item.objective}`
  );
  const frontierCount = payload.frontier_subgoal_ids.length;
  return [
    `新的执行计划已生成（第 ${payload.planning_round} 轮，${frontierCount} 个前沿 subgoal）。`,
    "",
    `需求：${demandTitle}`,
    "",
    "Plan 概览：",
    ...outlineLines,
    payload.overall_plan_outline.length > 8
      ? `  ... 还有 ${payload.overall_plan_outline.length - 8} 项，请到 Plan 面板查看完整结构。`
      : "",
    "",
    `Mission state：${payload.high_level_summary.mission_state_summary}`,
    "",
    "请选择：",
    "  • Approve：按此方案开始执行",
    "  • Provide Info：用文字告诉 planner 需要怎么调整，系统会根据你的反馈重新规划",
    "  • Reject / Cancel Demand：放弃当前方案"
  ].filter(Boolean).join("\n");
}

export async function onPlanGenerated(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (!demand) {
    logger.warn({ demandId: event.demand_id }, "忽略已生成计划，因为未找到对应需求");
    return {};
  }

  const planPayload = event.payload as PlanGeneratedPayload;
  const frontierSubgoalIds = planPayload.frontier_subgoal_ids ?? [];
  const planReason: EventReason | undefined = planPayload.reason;
  const needsReview = planReason ? REASONS_REQUIRING_PLAN_REVIEW.has(planReason) : true;

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

  logger.info({
    demandId: demand.demand_id,
    frontierSubgoalCount: frontierSubgoalIds.length,
    planReason,
    needsReview
  }, "已将生成计划保存到需求");

  if (!needsReview) {
    return {};
  }

  // 创建 PLAN_REVIEW 决策，让 demand 切到 PENDING_DECISION 暂停 subgoal 派发
  const prompt = buildPlanReviewPrompt(planPayload, demand.title || demand.initial_input);
  const decision = ctx.decisionService.createRequest({
    demandId: demand.demand_id,
    source: "scheduler" as any,
    reasonCode: DecisionReasonCode.PLAN_REVIEW,
    prompt,
    options: [
      DecisionAction.APPROVE,
      DecisionAction.PROVIDE_INFO,
      DecisionAction.REJECT,
      DecisionAction.CANCEL_DEMAND
    ],
    metadata: {
      plan_review: {
        planning_round: planPayload.planning_round,
        frontier_subgoal_ids: planPayload.frontier_subgoal_ids,
        plan_reason: planReason ?? null,
        outline_titles: planPayload.overall_plan_outline.map((item) => item.title)
      }
    }
  });
  logger.info({
    demandId: demand.demand_id,
    decisionId: decision.decision_id,
    planReason
  }, "已为新生成计划创建 PLAN_REVIEW 决策，等待用户审核");
  return {
    events: [
      createEvent(EventType.DECISION_REQUEST_CREATED, { decision_request: decision }, {
        demand_id: demand.demand_id,
        decision_id: decision.decision_id
      })
    ]
  };
}

/**
 * 函数作用：处理子目标创建事件并判断是否可以立即就绪。
 *
 * 参数说明：
 * - event：子目标创建事件。
 * - ctx：事件处理器上下文。
 *
 * 返回值：
 * - Promise<HandlerResult>：子目标解锁判断和后续事件发布结果。
 */
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
  if (demand.state === DemandState.PENDING_DECISION) {
    logger.info({
      demandId: demand.demand_id,
      state: demand.state,
      subgoalId: payload.subgoal_contract.subgoal_id,
      activeDecisionId: demand.active_decision_id
    }, "子目标保持计划中，等待用户审核 plan");
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

/**
 * 函数作用：处理子目标就绪事件并创建执行记录。
 *
 * 参数说明：
 * - event：子目标就绪事件。
 * - ctx：事件处理器上下文。
 *
 * 返回值：
 * - Promise<HandlerResult>：执行创建和派发链路启动结果。
 */
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
  const memorySnapshot = await ctx.memoryManager.getDispatchMemorySnapshot(ctx.repositories, demand.demand_id);
  const workspaceGrants = collectWorkspaceGrants(settings, demand);
  const packet = ctx.dispatcher.buildPacket({
    demand,
    subgoal: readySubgoal,
    execution,
    worker,
    workspaceRoot: settings.workspace_root,
    heartbeatSeconds: settings.runtime.heartbeat_interval_seconds,
    timeoutSeconds: settings.runtime.execution_timeout_seconds,
    memorySnapshot,
    workspaceGrants
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
