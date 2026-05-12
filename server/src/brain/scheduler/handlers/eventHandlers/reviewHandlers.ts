/**
 * 文件名称：reviewHandlers.ts
 * 文件作用：审查事件处理器模块，负责处理验证完成、决策请求和决策响应事件。
 *
 * 主要职责：
 * 1. 根据验证结果调用归并服务判断后续动作。
 * 2. 推进执行、子目标和需求状态。
 * 3. 在需要时创建决策请求或发布重规划事件。
 * 4. 处理用户或模型决策响应并继续调度流程。
 *
 * 依赖模块：
 * - domain：验证、决策、执行和事件类型。
 * - event_bus/types：处理器上下文。
 * - stateMachine：状态转换。
 * - planProgress：子目标解锁。
 * - shared：事件引用收集工具。
 *
 * 注意事项：
 * - 审查处理器连接执行结果与下一步调度，状态写入顺序需要保持一致。
 * - 决策响应动作新增时，应同步归并服务和本处理器分支。
 */
import {
  createEvent,
  DecisionAction,
  DemandPhase,
  DemandState,
  EventType,
  HandlerResult,
  SchedulerEvent,
  SubgoalState,
  nowIso
} from "../../../../domain/index.js";
import { HandlerContext } from "../../event_bus/types.js";
import { createLogger } from "../../../../logger.js";
import {
  DEMAND_TRANSITIONS,
  EXECUTION_TRANSITIONS,
  SUBGOAL_TRANSITIONS,
  assertTransition,
  transitionDemand
} from "../stateMachine.js";
import {
  appendExecutionGuidance,
  classifyDecisionReplyIntent,
  patchRuntimeSession
} from "../sessionState.js";
import { collectUnlockedPlannedSubgoals } from "../planProgress.js";
import {
  demandHasActiveExecutions,
  extractWorkerError,
  syncWorkerExecutionSlots
} from "../executionRuntime.js";
import { collectEventRefs } from "./shared.js";

const logger = createLogger("handlers:review");

/**
 * 函数作用：处理验证完成事件并根据归并结果推进调度。
 *
 * 参数说明：
 * - event：验证完成事件。
 * - ctx：事件处理器上下文。
 *
 * 返回值：
 * - Promise<HandlerResult>：执行、子目标、需求和后续事件处理结果。
 */
export async function onVerificationCompleted(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  const subgoal = await ctx.repositories.subgoals.getById(event.subgoal_id ?? "");
  const execution = await ctx.repositories.executions.getById(event.execution_id ?? "");
  const demandSubgoals = (await ctx.repositories.subgoals.list()).filter((item) => item.demand_id === event.demand_id);
  const workerResultEvent = (await ctx.repositories.events.list())
    .filter((item) => item.execution_id === event.execution_id && item.event_type === EventType.WORKER_RESULT_RECEIVED)
    .slice(-1)[0];
  if (!demand || !subgoal || !execution || !workerResultEvent) {
    logger.warn({ demandId: event.demand_id, subgoalId: event.subgoal_id, executionId: event.execution_id }, "忽略验证完成事件，因为必要记录未找到");
    return {};
  }
  const workerResult = (workerResultEvent.payload as { worker_result: any }).worker_result;
  const verification = (event.payload as { verification_result: any }).verification_result;
  logger.info({ demandId: demand.demand_id, subgoalId: subgoal.subgoal_id, executionId: execution.execution_id, verificationStatus: verification.verified_status }, "正在归并验证结果");
  const outcome = ctx.reconciliation.reconcile({ demand, subgoal, execution, workerResult, verification });
  const projectedSubgoals = demandSubgoals.map((item) => item.subgoal_id === outcome.subgoal.subgoal_id ? outcome.subgoal : item);

  if (verification.verified_status === "VERIFIED_DONE") {
    const unfinishedStates = new Set([
      SubgoalState.PLANNED,
      SubgoalState.READY,
      SubgoalState.DISPATCHED,
      SubgoalState.EXECUTING,
      SubgoalState.VERIFYING
    ]);
    const hasOtherUnfinishedSubgoals = projectedSubgoals.some((item) => (
      item.subgoal_id !== outcome.subgoal.subgoal_id && unfinishedStates.has(item.state)
    ));

    const latestPlan = (demand.metadata?.latest_plan ?? null) as {
      overall_plan_outline?: Array<{ frontier_subgoal_ids?: string[] }>;
    } | null;

    const hasFuturePlanSteps = Array.isArray(latestPlan?.overall_plan_outline)
      ? latestPlan!.overall_plan_outline.some((item) => {
          const ids = Array.isArray(item.frontier_subgoal_ids) ? item.frontier_subgoal_ids : [];
          if (ids.length === 0) {
            return true;
          }
          return !ids.some((subgoalId) => projectedSubgoals.some((candidate) => candidate.subgoal_id === subgoalId && candidate.state === SubgoalState.DONE));
        })
      : false;

    if (hasOtherUnfinishedSubgoals) {
      outcome.demand.state = DemandState.ACTIVE;
      outcome.demand.current_phase = DemandPhase.EXECUTION;
      outcome.demand.progress_percent = Math.min(95, Math.max(outcome.demand.progress_percent, 70));
      outcome.missionCompleted = false;
      outcome.replanRequested = false;
    } else if (hasFuturePlanSteps) {
      outcome.demand.state = DemandState.ACTIVE;
      outcome.demand.current_phase = DemandPhase.PLANNING;
      outcome.demand.progress_percent = Math.min(95, Math.max(outcome.demand.progress_percent, 75));
      outcome.missionCompleted = false;
      outcome.replanRequested = true;
    }
  }

  if (outcome.decisionReasonCode) {
    logger.info({ demandId: demand.demand_id, subgoalId: subgoal.subgoal_id, reasonCode: outcome.decisionReasonCode }, "验证结果需要用户决策");
    outcome.demand.state = DemandState.PENDING_DECISION;
    outcome.demand.current_phase = DemandPhase.REVIEW;
    outcome.missionCompleted = false;
    outcome.replanRequested = false;
  }

  assertTransition("demand", demand.state, outcome.demand.state, DEMAND_TRANSITIONS);
  assertTransition("subgoal", subgoal.state, outcome.subgoal.state, SUBGOAL_TRANSITIONS);
  assertTransition("execution", execution.state, outcome.execution.state, EXECUTION_TRANSITIONS);
  const reconciliationTimestamp = nowIso();
  const waitingOn = outcome.decisionReasonCode
    ? "user_decision"
    : outcome.replanRequested || outcome.missionCompleted
      ? null
      : "scheduler";
  await ctx.repositories.demands.upsert({
    ...outcome.demand,
    metadata: patchRuntimeSession(outcome.demand.metadata, {
      phase: outcome.demand.current_phase,
      waiting_on: waitingOn,
      progress_note: `Verification: ${verification.verified_status}`
    }, reconciliationTimestamp),
    updated_at: reconciliationTimestamp
  });
  await ctx.repositories.subgoals.upsert(outcome.subgoal);
  await ctx.repositories.executions.upsert(outcome.execution);
  await syncWorkerExecutionSlots(
    execution.worker_id,
    ctx,
    verification.verified_status === "FAILED" || verification.verified_status === "UNVERIFIABLE"
      ? extractWorkerError(workerResult)
      : null
  );
  for (const memory of ctx.memoryManager.createExecutionMemories({
    demandId: demand.demand_id,
    workerResult,
    verification
  })) {
    await ctx.repositories.memory.upsert(memory);
  }
  logger.info({
    demandId: demand.demand_id,
    subgoalId: subgoal.subgoal_id,
    executionId: execution.execution_id,
    demandState: outcome.demand.state,
    subgoalState: outcome.subgoal.state,
    executionState: outcome.execution.state,
    replanRequested: outcome.replanRequested,
    missionCompleted: outcome.missionCompleted
  }, "验证归并结果已保存");

  const events: SchedulerEvent<unknown>[] = [
    createEvent(
      EventType.RECONCILIATION_COMPLETED,
      {
        verification_status: verification.verified_status,
        decision_id: null,
        mission_completed: outcome.missionCompleted,
        replan_requested: outcome.replanRequested
      },
      {
        demand_id: demand.demand_id,
        subgoal_id: subgoal.subgoal_id,
        execution_id: execution.execution_id,
        worker_id: execution.worker_id
      }
    )
  ];

  if (verification.verified_status === "VERIFIED_DONE") {
    const unlockedSubgoalIds = collectUnlockedPlannedSubgoals(outcome.demand, projectedSubgoals);
    if (unlockedSubgoalIds.length > 0) {
      logger.info({ demandId: demand.demand_id, unlockedSubgoalIds }, "验证后已解锁计划中的子目标");
    }
    for (const unlockedSubgoalId of unlockedSubgoalIds) {
      events.push(
        createEvent(
          EventType.SUBGOAL_MARKED_READY,
          {
            dependency_check: {
              satisfied_dependencies: ["prior_plan_items_done"],
              remaining_dependencies: []
            }
          },
          {
            demand_id: demand.demand_id,
            subgoal_id: unlockedSubgoalId
          }
        )
      );
    }
  }

  if (outcome.decisionReasonCode && outcome.decisionPrompt) {
    const settings = await ctx.repositories.loadSettings();
    const prompt = await ctx.decisionService.buildPrompt({
      demand,
      settings,
      source: verification.verified_status === "UNVERIFIABLE" ? "verifier" : "worker",
      reasonCode: outcome.decisionReasonCode,
      fallbackPrompt: outcome.decisionPrompt
    });
    const decision = ctx.decisionService.createRequest({
      demandId: demand.demand_id,
      source: verification.verified_status === "UNVERIFIABLE" ? "verifier" : "worker",
      reasonCode: outcome.decisionReasonCode,
      prompt,
      subgoalId: subgoal.subgoal_id,
      executionId: execution.execution_id
    });
    logger.info({ demandId: demand.demand_id, subgoalId: subgoal.subgoal_id, executionId: execution.execution_id, decisionId: decision.decision_id }, "已根据验证结果创建决策请求");
    events.push(
      createEvent(EventType.DECISION_REQUEST_CREATED, { decision_request: decision }, {
        demand_id: demand.demand_id,
        subgoal_id: subgoal.subgoal_id,
        execution_id: execution.execution_id,
        decision_id: decision.decision_id
      })
    );
  } else if (outcome.replanRequested) {
    logger.info({ demandId: demand.demand_id }, "验证后准备请求重新规划");
    events.push(
      createEvent(EventType.REPLAN_REQUESTED, { reason: "replan_after_result" }, { demand_id: demand.demand_id })
    );
  } else if (outcome.missionCompleted) {
    logger.info({ demandId: demand.demand_id }, "验证结果已完成任务");
    events.push(
      createEvent(EventType.MISSION_COMPLETED, { summary: "Mission completed after verified execution" }, { demand_id: demand.demand_id })
    );
  }

  return { events };
}

/**
 * 函数作用：处理决策请求创建事件并推送给实时客户端。
 *
 * 参数说明：
 * - event：决策请求创建事件。
 * - ctx：事件处理器上下文。
 *
 * 返回值：
 * - Promise<HandlerResult>：决策请求广播结果。
 */
export async function onDecisionRequestCreated(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const payload = event.payload as { decision_request: any };
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (demand) {
    logger.info({ demandId: demand.demand_id, decisionId: payload.decision_request.decision_id, reasonCode: payload.decision_request.reason_code }, "正在保存决策请求");
    await ctx.repositories.demands.upsert(transitionDemand(demand, {
      state: DemandState.PENDING_DECISION,
      current_phase: DemandPhase.REVIEW,
      active_decision_id: payload.decision_request.decision_id
    }, {
      phase: DemandPhase.REVIEW,
      waiting_on: "user_decision",
      latest_checkpoint: payload.decision_request.decision_id,
      progress_note: `Decision required: ${payload.decision_request.reason_code}`
    }));
  } else {
    logger.warn({ demandId: event.demand_id, decisionId: payload.decision_request.decision_id }, "正在保存决策请求，但未找到对应需求");
  }
  await ctx.repositories.decisions.upsert(payload.decision_request);
  return {};
}

/**
 * 函数作用：处理决策响应事件并执行对应动作。
 *
 * 参数说明：
 * - event：决策响应事件。
 * - ctx：事件处理器上下文。
 *
 * 返回值：
 * - Promise<HandlerResult>：决策关闭、状态更新和后续事件发布结果。
 */
export async function onDecisionResponseReceived(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const payload = event.payload as { decision_response: { action: DecisionAction; note?: string; payload?: Record<string, unknown> } };
  const decision = await ctx.repositories.decisions.getById(event.decision_id ?? "");
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (!decision || !demand) {
    logger.warn({ demandId: event.demand_id, decisionId: event.decision_id }, "忽略决策响应，因为未找到决策或需求");
    return {};
  }
  const hasActiveExecutions = await demandHasActiveExecutions(demand.demand_id, ctx);
  logger.info({ demandId: demand.demand_id, decisionId: decision.decision_id, action: payload.decision_response.action, hasActiveExecutions }, "正在处理决策响应");

  if (payload.decision_response.action === DecisionAction.PROVIDE_INFO) {
    const note = payload.decision_response.note?.trim();
    if (!note) {
      logger.debug({ demandId: demand.demand_id, decisionId: decision.decision_id }, "忽略空的决策补充信息回复");
      return {};
    }
    const replyIntent = classifyDecisionReplyIntent(note);
    const settings = await ctx.repositories.loadSettings();
    const assistantReply = await ctx.decisionService.buildFollowUp({
      demand,
      settings,
      decision,
      userReply: note
    });
    const timestamp = nowIso();
    const updatedDecisionMetadata = ctx.decisionService.appendConversationTurns(decision.metadata, [
      { role: "user", content: note, created_at: timestamp },
      { role: "assistant", content: assistantReply, created_at: timestamp }
    ]);

    if (replyIntent === "chat" || hasActiveExecutions) {
      logger.info({ demandId: demand.demand_id, decisionId: decision.decision_id, replyIntent }, "决策对话已更新");
      await ctx.repositories.decisions.upsert({
        ...decision,
        status: "OPEN" as any,
        resolved_at: null,
        metadata: updatedDecisionMetadata
      });

      await ctx.repositories.demands.upsert(transitionDemand(demand, {
        state: DemandState.PENDING_DECISION,
        current_phase: DemandPhase.REVIEW,
        active_decision_id: decision.decision_id,
        updated_at: timestamp
      }, {
        phase: DemandPhase.REVIEW,
        waiting_on: "user_decision",
        latest_checkpoint: decision.decision_id,
        progress_note: "Decision conversation updated"
      }));
      return {};
    }

    logger.info({ demandId: demand.demand_id, decisionId: decision.decision_id, replyIntent }, "决策指导已接受，准备请求重新规划");
    await ctx.repositories.decisions.upsert({
      ...decision,
      status: "RESOLVED" as any,
      resolved_at: timestamp,
      metadata: updatedDecisionMetadata
    });

    await ctx.repositories.demands.upsert(transitionDemand(demand, {
      state: DemandState.READY,
      current_phase: DemandPhase.PLANNING,
      active_decision_id: null,
      metadata: appendExecutionGuidance(demand.metadata, {
        source: replyIntent,
        note,
        created_at: timestamp
      })
    }, {
      phase: DemandPhase.PLANNING,
      waiting_on: null,
      progress_note: `Decision guidance accepted: ${replyIntent}`
    }));

    return {
      events: [
        createEvent(
          EventType.REPLAN_REQUESTED,
          { reason: "replan_after_decision" },
          { demand_id: demand.demand_id }
        )
      ]
    };
  }

  await ctx.repositories.decisions.upsert({
    ...decision,
    status: "RESOLVED" as any,
    resolved_at: nowIso()
  });

  if (hasActiveExecutions) {
    const openDecisions = (await ctx.repositories.decisions.list()).filter((item) => (
      item.demand_id === demand.demand_id
      && item.status === "OPEN"
      && item.decision_id !== decision.decision_id
    ));

    const nextState = openDecisions.length > 0 ? DemandState.PENDING_DECISION : DemandState.ACTIVE;
    const nextPhase = openDecisions.length > 0 ? DemandPhase.REVIEW : DemandPhase.EXECUTION;
    await ctx.repositories.demands.upsert(transitionDemand(demand, {
      state: nextState,
      current_phase: nextPhase,
      active_decision_id: openDecisions[0]?.decision_id ?? null
    }, {
      phase: nextPhase,
      waiting_on: openDecisions.length > 0 ? "user_decision" : "worker_result",
      latest_checkpoint: openDecisions[0]?.decision_id ?? undefined,
      progress_note: "Decision resolved"
    }));
  } else if (
    payload.decision_response.action !== DecisionAction.PAUSE
    && payload.decision_response.action !== DecisionAction.CANCEL_DEMAND
  ) {
    await ctx.repositories.demands.upsert(transitionDemand(demand, {
      state: DemandState.READY,
      current_phase: DemandPhase.PLANNING,
      active_decision_id: null
    }, {
      phase: DemandPhase.PLANNING,
      waiting_on: null,
      progress_note: "Decision resolved"
    }));
  }

  if (payload.decision_response.action === DecisionAction.PAUSE) {
    logger.info({ demandId: demand.demand_id, decisionId: decision.decision_id }, "决策请求暂停需求");
    return {
      events: [createEvent(EventType.DEMAND_PAUSED, { action: "pause", note: payload.decision_response.note }, { demand_id: demand.demand_id })]
    };
  }

  if (payload.decision_response.action === DecisionAction.CANCEL_DEMAND) {
    logger.info({ demandId: demand.demand_id, decisionId: decision.decision_id }, "决策请求取消需求");
    return {
      events: [createEvent(EventType.DEMAND_CANCELLED, { action: "cancel", note: payload.decision_response.note }, { demand_id: demand.demand_id })]
    };
  }

  if (payload.decision_response.action === DecisionAction.STOP) {
    const events: SchedulerEvent<unknown>[] = [];
    if (event.execution_id) {
      logger.info({ demandId: demand.demand_id, decisionId: decision.decision_id, executionId: event.execution_id }, "决策请求停止执行");
      events.push(createEvent(
        EventType.EXECUTION_STOP_REQUESTED,
        { reason: payload.decision_response.note ?? "decision_stop" },
        collectEventRefs(event)
      ));
    }
    events.push(createEvent(EventType.REPLAN_REQUESTED, { reason: "replan_after_decision" }, { demand_id: demand.demand_id }));
    return { events };
  }

  if (hasActiveExecutions) {
    logger.info({ demandId: demand.demand_id, decisionId: decision.decision_id }, "决策已解决，但仍有活跃执行");
    return {};
  }

  logger.info({ demandId: demand.demand_id, decisionId: decision.decision_id }, "决策已解决，准备请求重新规划");
  return {
    events: [createEvent(EventType.REPLAN_REQUESTED, { reason: "replan_after_decision" }, { demand_id: demand.demand_id })]
  };
}
