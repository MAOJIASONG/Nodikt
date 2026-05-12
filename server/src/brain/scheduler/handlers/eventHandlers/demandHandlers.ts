/**
 * 文件名称：demandHandlers.ts
 * 文件作用：需求事件处理器模块，负责处理用户输入、澄清完成、暂停、恢复、取消和任务完成事件。
 *
 * 主要职责：
 * 1. 将用户输入转换为新需求或既有需求的会话更新。
 * 2. 推进需求澄清、规划和完成状态。
 * 3. 处理需求级控制动作，包括暂停、恢复和取消。
 * 4. 发布后续规划、执行停止或完成事件。
 *
 * 依赖模块：
 * - domain：需求、事件和状态类型。
 * - event_bus/types：处理器上下文。
 * - stateMachine 与 sessionState：状态流转和会话元数据维护。
 * - executionRuntime：活跃执行查询。
 *
 * 注意事项：
 * - 需求控制动作可能影响多个执行和子目标，必须保持事件链完整。
 * - 用户输入处理应兼容新需求和澄清回复两种场景。
 */
import {
  createEvent,
  createId,
  DemandPhase,
  DemandState,
  EventType,
  HandlerResult,
  SchedulerEvent,
  nowIso
} from "../../../../domain/index.js";
import { HandlerContext } from "../../event_bus/types.js";
import { createLogger } from "../../../../logger.js";
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

/**
 * 函数作用：处理用户输入事件，创建新需求或更新既有需求会话。
 *
 * 参数说明：
 * - event：用户输入事件。
 * - ctx：事件处理器上下文。
 *
 * 返回值：
 * - Promise<HandlerResult>：需求创建、澄清或对话更新后的处理结果。
 */
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

/**
 * 函数作用：处理需求澄清完成事件并触发初始规划。
 *
 * 参数说明：
 * - event：需求澄清完成事件。
 * - ctx：事件处理器上下文。
 *
 * 返回值：
 * - Promise<HandlerResult>：需求状态更新和后续规划事件发布结果。
 */
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

/**
 * 函数作用：处理需求暂停事件。
 *
 * 参数说明：
 * - event：需求暂停事件。
 * - ctx：事件处理器上下文。
 *
 * 返回值：
 * - Promise<HandlerResult>：暂停后的需求状态处理结果。
 */
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

/**
 * 函数作用：处理需求恢复事件。
 *
 * 参数说明：
 * - event：需求恢复事件。
 * - ctx：事件处理器上下文。
 *
 * 返回值：
 * - Promise<HandlerResult>：恢复后的需求状态处理结果。
 */
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

/**
 * 函数作用：处理需求取消事件并停止关联活跃执行。
 *
 * 参数说明：
 * - event：需求取消事件。
 * - ctx：事件处理器上下文。
 *
 * 返回值：
 * - Promise<HandlerResult>：取消后的需求、子目标和执行处理结果。
 */
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

/**
 * 函数作用：处理任务完成事件并将需求推进到完成状态。
 *
 * 参数说明：
 * - event：任务完成事件。
 * - ctx：事件处理器上下文。
 *
 * 返回值：
 * - Promise<HandlerResult>：需求完成状态更新结果。
 */
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
