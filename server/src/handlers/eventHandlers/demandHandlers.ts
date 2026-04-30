import {
  createEvent,
  createId,
  DemandPhase,
  DemandState,
  EventType,
  HandlerResult,
  SchedulerEvent,
  nowIso
} from "../../domain/index.js";
import { HandlerContext } from "../../event_bus/types.js";
import { createLogger } from "../../logger.js";
import {
  appendConversationTurns,
  readConversationHistory
} from "../sessionState.js";
import {
  isTerminalDemand,
  transitionDemand
} from "../stateMachine.js";
import { listActiveExecutionsForDemand } from "../executionRuntime.js";

const logger = createLogger("handlers:demand");

export async function onUserInput(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const payload = event.payload as { input_text: string; input_kind: string };
  logger.info({ eventId: event.event_id, inputKind: payload.input_kind, demandId: event.demand_id }, "收到用户输入事件");
  if (payload.input_kind === "initial_demand") {
    const timestamp = nowIso();
    const demandId = event.demand_id ?? createId("demand");
    const settings = await ctx.repositories.loadSettings();
    logger.info({ demandId }, "开始澄清初始需求");
    const clarification = await ctx.planner.clarifyDemand({
      rawInput: payload.input_text,
      settings
    });
    await ctx.repositories.demands.upsert({
      demand_id: demandId,
      title: clarification.display_title?.slice(0, 60) || payload.input_text.slice(0, 80),
      type: "project",
      initial_input: payload.input_text,
      clarified_demand: null,
      operational_objective: null,
      state: DemandState.PENDING_ALIGNMENT,
      autonomy_level: settings.default_autonomy_level,
      acceptance_criteria: [],
      constraints: [],
      progress_percent: 0,
      current_phase: DemandPhase.ALIGNMENT,
      active_decision_id: null,
      tags: [],
      created_at: timestamp,
      updated_at: timestamp,
      metadata: clarification.status === "NEEDS_CLARIFICATION"
        ? {
            runtime_session: {
              phase: DemandPhase.ALIGNMENT,
              waiting_on: "user_clarification",
              frontier_subgoal_ids: [],
              latest_checkpoint: event.event_id,
              progress_note: "Initial demand needs clarification",
              last_progress_at: timestamp
            },
            clarification_question: clarification.clarification_question,
            conversation_history: [
              { role: "user", content: payload.input_text, created_at: timestamp },
              {
                role: "assistant",
                content: clarification.clarification_question ?? "Please provide the missing project/workspace path and key constraints.",
                created_at: timestamp
              }
            ]
          }
        : {
            runtime_session: {
              phase: DemandPhase.ALIGNMENT,
              waiting_on: null,
              frontier_subgoal_ids: [],
              latest_checkpoint: event.event_id,
              progress_note: "Initial demand clarified",
              last_progress_at: timestamp
            },
            conversation_history: [
              { role: "user", content: payload.input_text, created_at: timestamp },
              {
                role: "assistant",
                content: clarification.clarification_summary ?? "Clarification is complete. Moving to planning.",
                created_at: timestamp
              }
            ]
          }
    });

    if (clarification.status === "NEEDS_CLARIFICATION") {
      logger.info({ demandId }, "初始需求仍需要用户补充澄清");
      return {};
    }

    logger.info({ demandId }, "初始需求澄清已完成");
    return {
      events: [
        createEvent(
          EventType.DEMAND_CLARIFICATION_COMPLETED,
          {
            clarified_demand: clarification.clarified_demand!,
            operational_objective: clarification.operational_objective!,
            acceptance_criteria: clarification.operational_objective!.acceptance_criteria,
            constraints: clarification.operational_objective!.constraints,
            clarification_summary: clarification.clarification_summary!
          },
          { demand_id: demandId }
        )
      ]
    };
  }

  if (payload.input_kind === "clarification_reply" && event.demand_id) {
    const demand = await ctx.repositories.demands.getById(event.demand_id);
    if (!demand) {
      logger.warn({ demandId: event.demand_id }, "忽略澄清回复，因为未找到对应需求");
      return {};
    }
    const settings = await ctx.repositories.loadSettings();
    const timestamp = nowIso();
    logger.info({ demandId: demand.demand_id }, "正在使用用户回复继续澄清需求");
    const clarification = await ctx.planner.clarifyDemand({
      rawInput: [
        `Original demand: ${demand.initial_input}`,
        `Clarification conversation so far: ${JSON.stringify(readConversationHistory(demand.metadata))}`,
        demand.metadata?.clarification_question
          ? `Previous clarification question: ${String(demand.metadata.clarification_question)}`
          : "",
        `User clarification reply: ${payload.input_text}`
      ].filter(Boolean).join("\n"),
      settings
    });

    if (clarification.status === "NEEDS_CLARIFICATION") {
      logger.info({ demandId: demand.demand_id }, "澄清回复仍需要更多用户输入");
      await ctx.repositories.demands.upsert(transitionDemand(demand, {
        title: clarification.display_title?.slice(0, 60) || demand.title,
        metadata: {
          ...appendConversationTurns(demand.metadata, [
            { role: "user", content: payload.input_text, created_at: timestamp },
            {
              role: "assistant",
              content: clarification.clarification_question ?? "Please provide the remaining missing execution context.",
              created_at: timestamp
            }
          ]),
          clarification_question: clarification.clarification_question
        }
      }, {
        phase: DemandPhase.ALIGNMENT,
        waiting_on: "user_clarification",
        progress_note: "Clarification still needed"
      }));
      return {};
    }

    logger.info({ demandId: demand.demand_id }, "澄清回复已接受");
    await ctx.repositories.demands.upsert(transitionDemand(demand, {
      title: clarification.display_title?.slice(0, 60) || demand.title,
      metadata: {
        ...appendConversationTurns(demand.metadata, [
          { role: "user", content: payload.input_text, created_at: timestamp },
          {
            role: "assistant",
            content: clarification.clarification_summary ?? "Clarification is complete. Moving to planning.",
            created_at: timestamp
          }
        ]),
        clarification_question: null
      }
    }, {
      phase: DemandPhase.ALIGNMENT,
      waiting_on: null,
      progress_note: "Clarification reply accepted"
    }));

    return {
      events: [
        createEvent(
          EventType.DEMAND_CLARIFICATION_COMPLETED,
          {
            clarified_demand: clarification.clarified_demand!,
            operational_objective: clarification.operational_objective!,
            acceptance_criteria: clarification.operational_objective!.acceptance_criteria,
            constraints: clarification.operational_objective!.constraints,
            clarification_summary: clarification.clarification_summary!
          },
          { demand_id: demand.demand_id }
        )
      ]
    };
  }

  logger.debug({ eventId: event.event_id, inputKind: payload.input_kind }, "忽略不支持的用户输入类型");
  return {};
}

export async function onClarificationCompleted(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (!demand) {
    logger.warn({ demandId: event.demand_id }, "忽略澄清完成事件，因为未找到对应需求");
    return {};
  }
  const payload = event.payload as {
    clarified_demand: string;
    operational_objective: NonNullable<typeof demand.operational_objective>;
    acceptance_criteria: string[];
    constraints: string[];
  };

  await ctx.repositories.demands.upsert(transitionDemand(demand, {
    clarified_demand: payload.clarified_demand,
    operational_objective: payload.operational_objective,
    acceptance_criteria: payload.acceptance_criteria,
    constraints: payload.constraints,
    state: DemandState.READY,
    current_phase: DemandPhase.PLANNING,
    metadata: {
      ...(demand.metadata ?? {}),
      clarification_question: null
    }
  }, {
    phase: DemandPhase.PLANNING,
    waiting_on: null,
    progress_note: "Clarification completed"
  }));

  logger.info({ demandId: demand.demand_id }, "需求澄清已完成，准备请求初始规划");
  return {
    events: [createEvent(EventType.REPLAN_REQUESTED, { reason: "initial_plan" }, { demand_id: demand.demand_id })]
  };
}

export async function onDemandPaused(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (!demand) {
    logger.warn({ demandId: event.demand_id }, "忽略暂停请求，因为未找到对应需求");
    return {};
  }
  if (isTerminalDemand(demand)) {
    logger.debug({ demandId: demand.demand_id, state: demand.state }, "忽略终态需求的暂停请求");
    return {};
  }
  await ctx.repositories.demands.upsert(transitionDemand(demand, {
    state: DemandState.PAUSED
  }, {
    waiting_on: "resume",
    progress_note: "Demand paused"
  }));

  const activeExecutions = await listActiveExecutionsForDemand(demand.demand_id, ctx);
  logger.info({ demandId: demand.demand_id, activeExecutionCount: activeExecutions.length }, "需求已暂停");
  return {
    events: activeExecutions.map((execution) => createEvent(
      EventType.EXECUTION_STOP_REQUESTED,
      { reason: "demand_paused" },
      {
        demand_id: demand.demand_id,
        subgoal_id: execution.subgoal_id,
        execution_id: execution.execution_id,
        worker_id: execution.worker_id
      }
    ))
  };
}

export async function onDemandResumed(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (!demand) {
    logger.warn({ demandId: event.demand_id }, "忽略恢复请求，因为未找到对应需求");
    return {};
  }
  if (isTerminalDemand(demand)) {
    logger.debug({ demandId: demand.demand_id, state: demand.state }, "忽略终态需求的恢复请求");
    return {};
  }
  await ctx.repositories.demands.upsert(transitionDemand(demand, {
    state: DemandState.READY,
    current_phase: DemandPhase.PLANNING
  }, {
    phase: DemandPhase.PLANNING,
    waiting_on: null,
    progress_note: "Demand resumed"
  }));
  logger.info({ demandId: demand.demand_id }, "需求已恢复，准备请求重新规划");
  return {
    events: [createEvent(EventType.REPLAN_REQUESTED, { reason: "resume" }, { demand_id: demand.demand_id })]
  };
}

export async function onDemandCancelled(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (!demand) {
    logger.warn({ demandId: event.demand_id }, "忽略取消请求，因为未找到对应需求");
    return {};
  }
  if (isTerminalDemand(demand)) {
    logger.debug({ demandId: demand.demand_id, state: demand.state }, "忽略终态需求的取消请求");
    return {};
  }
  await ctx.repositories.demands.upsert(transitionDemand(demand, {
    state: DemandState.CANCELLED,
    current_phase: DemandPhase.CANCELLED
  }, {
    phase: DemandPhase.CANCELLED,
    waiting_on: null,
    progress_note: "Demand cancelled"
  }));

  const activeExecutions = await listActiveExecutionsForDemand(demand.demand_id, ctx);
  logger.info({ demandId: demand.demand_id, activeExecutionCount: activeExecutions.length }, "需求已取消");
  return {
    events: activeExecutions.map((execution) => createEvent(
      EventType.EXECUTION_STOP_REQUESTED,
      { reason: "demand_cancelled" },
      {
        demand_id: demand.demand_id,
        subgoal_id: execution.subgoal_id,
        execution_id: execution.execution_id,
        worker_id: execution.worker_id
      }
    ))
  };
}

export async function onMissionCompleted(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (!demand) {
    logger.warn({ demandId: event.demand_id }, "忽略任务完成事件，因为未找到对应需求");
    return {};
  }
  await ctx.repositories.demands.upsert(transitionDemand(demand, {
    state: DemandState.COMPLETED,
    current_phase: DemandPhase.COMPLETED,
    progress_percent: 100
  }, {
    phase: DemandPhase.COMPLETED,
    waiting_on: null,
    progress_note: "Mission completed"
  }));
  logger.info({ demandId: demand.demand_id }, "任务已完成");
  return {};
}
