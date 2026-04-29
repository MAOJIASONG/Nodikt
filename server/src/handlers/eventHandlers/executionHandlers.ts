import {
  createEvent,
  DemandPhase,
  DemandState,
  EventType,
  ExecutionState,
  HandlerResult,
  SchedulerEvent,
  SubgoalState,
  WorkerRegistryStatus,
  nowIso
} from "../../domain/index.js";
import { HandlerContext } from "../../event_bus/types.js";
import {
  ACTIVE_EXECUTION_STATES,
  transitionDemand,
  transitionExecution,
  transitionSubgoal
} from "../stateMachine.js";
import {
  createWorkerFailureResult,
  syncWorkerExecutionSlots
} from "../executionRuntime.js";

export async function onExecutionCreated(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const payload = event.payload as { execution: any; dispatch_packet: any };
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  const subgoal = await ctx.repositories.subgoals.getById(event.subgoal_id ?? "");
  const worker = await ctx.repositories.workers.getById(event.worker_id ?? "");
  if (!demand || !subgoal || !worker) {
    return {};
  }

  await ctx.repositories.executions.upsert(payload.execution);
  await ctx.repositories.demands.upsert(transitionDemand(demand, {
    state: DemandState.ACTIVE,
    current_phase: DemandPhase.EXECUTION
  }, {
    phase: DemandPhase.EXECUTION,
    waiting_on: "worker_result",
    latest_checkpoint: payload.execution.execution_id,
    progress_note: `Dispatched subgoal ${subgoal.subgoal_id}`
  }));
  await ctx.repositories.subgoals.upsert(transitionSubgoal(subgoal, { state: SubgoalState.DISPATCHED }));
  await ctx.repositories.workers.upsert({
    ...worker,
    status: WorkerRegistryStatus.BUSY,
    current_execution_ids: [...worker.current_execution_ids, payload.execution.execution_id],
    updated_at: nowIso()
  });

  return {
    events: [
      createEvent(
        EventType.EXECUTION_DISPATCHED,
        {
          adapter_type: worker.adapter_type,
          runtime_type: worker.runtime_type,
          dispatch_started_at: nowIso()
        },
        {
          demand_id: event.demand_id,
          subgoal_id: event.subgoal_id,
          execution_id: event.execution_id,
          worker_id: event.worker_id
        }
      )
    ]
  };
}

export async function onExecutionDispatched(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const execution = await ctx.repositories.executions.getById(event.execution_id ?? "");
  const worker = await ctx.repositories.workers.getById(event.worker_id ?? "");
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  const subgoal = await ctx.repositories.subgoals.getById(event.subgoal_id ?? "");
  const settings = await ctx.repositories.loadSettings();
  if (!execution || !worker || !demand || !subgoal || !demand.operational_objective) {
    return {};
  }

  const adapter = ctx.adapterRegistry.getAdapter(worker.worker_id);
  if (!adapter) {
    return {};
  }

  const packet = ctx.dispatcher.buildPacket({
    demand,
    subgoal,
    execution,
    worker,
    workspaceRoot: settings.workspace_root,
    heartbeatSeconds: settings.runtime.heartbeat_interval_seconds,
    timeoutSeconds: settings.runtime.execution_timeout_seconds
  });

  const startedAt = nowIso();
  const runningExecution = transitionExecution(execution, {
    state: ExecutionState.RUNNING,
    started_at: startedAt
  });
  const executingSubgoal = transitionSubgoal(subgoal, { state: SubgoalState.EXECUTING });

  try {
    ctx.adapterRegistry.bindExecution(execution.execution_id, worker.worker_id);
    await adapter.startExecution(packet);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.repositories.executions.upsert(runningExecution);
    await ctx.repositories.subgoals.upsert(executingSubgoal);
    return {
      events: [
        createEvent(
          EventType.WORKER_RESULT_RECEIVED,
          {
            worker_result: createWorkerFailureResult({
              executionId: execution.execution_id,
              workerId: worker.worker_id,
              code: "WORKER_START_FAILED",
              message,
              startedAt,
              suggestedNextStep: "Inspect worker command, cwd, environment, and retry or request human decision"
            })
          },
          {
            demand_id: event.demand_id,
            subgoal_id: event.subgoal_id,
            execution_id: event.execution_id,
            worker_id: event.worker_id
          }
        )
      ]
    };
  }

  await ctx.repositories.executions.upsert(runningExecution);
  await ctx.repositories.subgoals.upsert(executingSubgoal);
  return {};
}

export async function onWorkerHeartbeat(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const execution = await ctx.repositories.executions.getById(event.execution_id ?? "");
  if (!execution) {
    return {};
  }

  const payload = event.payload as { heartbeat: { emitted_at: string; status: any } };
  await ctx.repositories.executions.upsert(transitionExecution(execution, {
    last_heartbeat_at: payload.heartbeat.emitted_at,
    latest_worker_status: payload.heartbeat.status
  }));
  return {};
}

export async function onWorkerResult(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const execution = await ctx.repositories.executions.getById(event.execution_id ?? "");
  const subgoal = await ctx.repositories.subgoals.getById(event.subgoal_id ?? "");
  if (!execution || !subgoal) {
    return {};
  }
  if (!ACTIVE_EXECUTION_STATES.has(execution.state)) {
    return {};
  }
  const payload = event.payload as { worker_result: any };
  const resultExecution = execution.state === ExecutionState.QUEUED
    ? transitionExecution(execution, {
        state: ExecutionState.RUNNING,
        started_at: execution.started_at ?? nowIso()
      })
    : execution;
  const resultSubgoal = subgoal.state === SubgoalState.DISPATCHED
    ? transitionSubgoal(subgoal, { state: SubgoalState.EXECUTING })
    : subgoal;

  await ctx.repositories.executions.upsert(transitionExecution(resultExecution, {
    state: ExecutionState.VERIFYING,
    result_status: payload.worker_result.worker_status,
    claimed_outcome: payload.worker_result.claimed_outcome ?? null,
    compressed_history: payload.worker_result.compressed_history,
    artifacts: payload.worker_result.produced_artifacts,
    adapter_meta: payload.worker_result.adapter_meta ?? {}
  }));
  await ctx.repositories.subgoals.upsert(transitionSubgoal(resultSubgoal, { state: SubgoalState.VERIFYING }));

  const verification = ctx.verifier.verify(subgoal.subgoal_id, payload.worker_result);
  return {
    events: [
      createEvent(
        EventType.VERIFICATION_COMPLETED,
        { verification_result: verification },
        {
          demand_id: event.demand_id,
          subgoal_id: event.subgoal_id,
          execution_id: event.execution_id,
          worker_id: event.worker_id
        }
      )
    ]
  };
}

export async function onExecutionStopRequested(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const execution = await ctx.repositories.executions.getById(event.execution_id ?? "");
  if (!execution || !ACTIVE_EXECUTION_STATES.has(execution.state)) {
    return {};
  }

  const payload = event.payload as { reason?: string };
  const shouldCancel = payload.reason === "demand_cancelled";
  const adapter = ctx.adapterRegistry.getExecutionAdapter(execution.execution_id);
  let stopError: string | null = null;
  if (adapter) {
    try {
      await adapter.stopExecution(execution.execution_id);
    } catch (error) {
      stopError = error instanceof Error ? error.message : String(error);
    }
  }

  await ctx.repositories.executions.upsert(transitionExecution(execution, {
    state: shouldCancel ? ExecutionState.CANCELLED : ExecutionState.INTERRUPTED,
    completed_at: nowIso()
  }));

  const subgoal = await ctx.repositories.subgoals.getById(execution.subgoal_id);
  if (subgoal && ![SubgoalState.DONE, SubgoalState.FAILED, SubgoalState.CANCELLED].includes(subgoal.state)) {
    await ctx.repositories.subgoals.upsert(transitionSubgoal(subgoal, {
      state: shouldCancel ? SubgoalState.CANCELLED : SubgoalState.BLOCKED
    }));
  }

  await syncWorkerExecutionSlots(execution.worker_id, ctx, stopError);
  return {};
}
