import {
  createEvent,
  EventType,
  ExecutionState,
  HandlerResult,
  SchedulerEvent
} from "../../domain/index.js";
import { HandlerContext } from "../../event_bus/types.js";
import {
  ACTIVE_EXECUTION_STATES,
  transitionExecution
} from "../stateMachine.js";

export async function onOpsAlert(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const execution = await ctx.repositories.executions.getById(event.execution_id ?? "");
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (execution && ACTIVE_EXECUTION_STATES.has(execution.state)) {
    await ctx.repositories.executions.upsert(transitionExecution(execution, {
      state: ExecutionState.TIMEOUT
    }));
  }
  if (demand) {
    const settings = await ctx.repositories.loadSettings();
    const prompt = await ctx.decisionService.buildPrompt({
      demand,
      settings,
      source: "ops",
      reasonCode: "OPS_ALERT" as any,
      fallbackPrompt: (event.payload as { message: string }).message
    });
    const decision = ctx.decisionService.createRequest({
      demandId: demand.demand_id,
      source: "ops",
      reasonCode: "OPS_ALERT" as any,
      prompt,
      executionId: execution?.execution_id ?? null,
      subgoalId: execution?.subgoal_id ?? null
    });
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
  return {};
}
