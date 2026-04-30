import {
  createEvent,
  EventType,
  ExecutionState,
  HandlerResult,
  SchedulerEvent
} from "../../domain/index.js";
import { HandlerContext } from "../../event_bus/types.js";
import { createLogger } from "../../logger.js";
import {
  ACTIVE_EXECUTION_STATES,
  transitionExecution
} from "../stateMachine.js";

const logger = createLogger("handlers:ops");

export async function onOpsAlert(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const execution = await ctx.repositories.executions.getById(event.execution_id ?? "");
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  const payload = event.payload as { code?: string; message: string; severity?: string };
  logger.warn({
    demandId: event.demand_id,
    executionId: event.execution_id,
    code: payload.code,
    severity: payload.severity
  }, "收到运维告警");
  if (execution && ACTIVE_EXECUTION_STATES.has(execution.state)) {
    await ctx.repositories.executions.upsert(transitionExecution(execution, {
      state: ExecutionState.TIMEOUT
    }));
    logger.warn({ executionId: execution.execution_id, previousState: execution.state }, "已根据运维告警将执行标记为超时");
  }
  if (demand) {
    const settings = await ctx.repositories.loadSettings();
    const prompt = await ctx.decisionService.buildPrompt({
      demand,
      settings,
      source: "ops",
      reasonCode: "OPS_ALERT" as any,
      fallbackPrompt: payload.message
    });
    const decision = ctx.decisionService.createRequest({
      demandId: demand.demand_id,
      source: "ops",
      reasonCode: "OPS_ALERT" as any,
      prompt,
      executionId: execution?.execution_id ?? null,
      subgoalId: execution?.subgoal_id ?? null
    });
    logger.info({ demandId: demand.demand_id, executionId: execution?.execution_id, decisionId: decision.decision_id }, "已根据运维告警创建决策请求");
    return {
      events: [
        createEvent(EventType.DECISION_REQUEST_CREATED, { decision_request: decision }, {
          demand_id: demand.demand_id,
          subgoal_id: execution?.subgoal_id ?? null,
          execution_id: execution?.execution_id ?? null,
          decision_id: decision.decision_id
        })
      ]
    };
  }
  logger.warn({ demandId: event.demand_id, executionId: event.execution_id }, "运维告警未匹配到需求");
  return {};
}
