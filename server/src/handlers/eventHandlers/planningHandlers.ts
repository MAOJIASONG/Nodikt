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
import {
  isTerminalDemand,
  transitionDemand,
  transitionSubgoal
} from "../stateMachine.js";
import { isSubgoalUnlockedByPlan } from "../planProgress.js";
import { demandHasActiveExecutions } from "../executionRuntime.js";

export async function onReplanRequested(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (!demand || !demand.operational_objective) {
    return {};
  }
  if (isTerminalDemand(demand) || demand.state === DemandState.PAUSED) {
    return {};
  }

  const settings = await ctx.repositories.loadSettings();
  const planningRound = (await ctx.repositories.subgoals.list()).filter((item) => item.demand_id === demand.demand_id).length + 1;
  const plan = await ctx.planner.generateFrontierPlan(
    demand,
    (event.payload as { reason: "initial_plan" | "replan_after_result" | "replan_after_decision" | "resume" }).reason,
    planningRound,
    settings
  );
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
    return {};
  }

  await ctx.repositories.demands.upsert(transitionDemand(demand, {
    metadata: {
      ...(demand.metadata ?? {}),
      latest_plan: event.payload
    }
  }, {
    phase: DemandPhase.PLANNING,
    frontier_subgoal_ids: (event.payload as { frontier_subgoal_ids?: string[] }).frontier_subgoal_ids ?? [],
    progress_note: "Frontier plan generated"
  }));

  return {};
}

export async function onSubgoalCreated(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const payload = event.payload as { subgoal_contract: any };
  await ctx.repositories.subgoals.upsert(payload.subgoal_contract);

  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (!demand) {
    return {};
  }
  if (isTerminalDemand(demand) || demand.state === DemandState.PAUSED) {
    return {};
  }

  const demandSubgoals = (await ctx.repositories.subgoals.list()).filter((item) => item.demand_id === demand.demand_id);
  const shouldUnlock = isSubgoalUnlockedByPlan(demand, payload.subgoal_contract.subgoal_id, demandSubgoals);
  if (!shouldUnlock) {
    return {};
  }

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
    return {};
  }
  if (isTerminalDemand(demand) || demand.state === DemandState.PAUSED) {
    return {};
  }
  if (![SubgoalState.PLANNED, SubgoalState.BLOCKED].includes(subgoal.state)) {
    return {};
  }

  const readySubgoal = transitionSubgoal(subgoal, { state: SubgoalState.READY });
  await ctx.repositories.subgoals.upsert(readySubgoal);

  const worker = ctx.dispatcher.selectWorker(workers, readySubgoal);
  if (!worker) {
    if (await demandHasActiveExecutions(demand.demand_id, ctx)) {
      return {};
    }
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
