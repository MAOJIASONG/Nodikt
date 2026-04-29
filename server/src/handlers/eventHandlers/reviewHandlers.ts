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
} from "../../domain/index.js";
import { HandlerContext } from "../../event_bus/types.js";
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

export async function onVerificationCompleted(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  const subgoal = await ctx.repositories.subgoals.getById(event.subgoal_id ?? "");
  const execution = await ctx.repositories.executions.getById(event.execution_id ?? "");
  const demandSubgoals = (await ctx.repositories.subgoals.list()).filter((item) => item.demand_id === event.demand_id);
  const workerResultEvent = (await ctx.repositories.events.list())
    .filter((item) => item.execution_id === event.execution_id && item.event_type === EventType.WORKER_RESULT_RECEIVED)
    .slice(-1)[0];
  if (!demand || !subgoal || !execution || !workerResultEvent) {
    return {};
  }
  const workerResult = (workerResultEvent.payload as { worker_result: any }).worker_result;
  const verification = (event.payload as { verification_result: any }).verification_result;
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
    events.push(
      createEvent(EventType.DECISION_REQUEST_CREATED, { decision_request: decision }, {
        demand_id: demand.demand_id,
        subgoal_id: subgoal.subgoal_id,
        execution_id: execution.execution_id,
        decision_id: decision.decision_id
      })
    );
  } else if (outcome.replanRequested) {
    events.push(
      createEvent(EventType.REPLAN_REQUESTED, { reason: "replan_after_result" }, { demand_id: demand.demand_id })
    );
  } else if (outcome.missionCompleted) {
    events.push(
      createEvent(EventType.MISSION_COMPLETED, { summary: "Mission completed after verified execution" }, { demand_id: demand.demand_id })
    );
  }

  return { events };
}

export async function onDecisionRequestCreated(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const payload = event.payload as { decision_request: any };
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (demand) {
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
  }
  await ctx.repositories.decisions.upsert(payload.decision_request);
  return {};
}

export async function onDecisionResponseReceived(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const payload = event.payload as { decision_response: { action: DecisionAction; note?: string; payload?: Record<string, unknown> } };
  const decision = await ctx.repositories.decisions.getById(event.decision_id ?? "");
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (!decision || !demand) {
    return {};
  }
  const hasActiveExecutions = await demandHasActiveExecutions(demand.demand_id, ctx);

  if (payload.decision_response.action === DecisionAction.PROVIDE_INFO) {
    const note = payload.decision_response.note?.trim();
    if (!note) {
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
    return {
      events: [createEvent(EventType.DEMAND_PAUSED, { action: "pause", note: payload.decision_response.note }, { demand_id: demand.demand_id })]
    };
  }

  if (payload.decision_response.action === DecisionAction.CANCEL_DEMAND) {
    return {
      events: [createEvent(EventType.DEMAND_CANCELLED, { action: "cancel", note: payload.decision_response.note }, { demand_id: demand.demand_id })]
    };
  }

  if (payload.decision_response.action === DecisionAction.STOP) {
    const events: SchedulerEvent<unknown>[] = [];
    if (event.execution_id) {
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
    return {};
  }

  return {
    events: [createEvent(EventType.REPLAN_REQUESTED, { reason: "replan_after_decision" }, { demand_id: demand.demand_id })]
  };
}
