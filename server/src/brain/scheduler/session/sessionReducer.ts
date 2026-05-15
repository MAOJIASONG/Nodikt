import {
  DecisionAction,
  Demand,
  DemandPhase,
  EventType,
  SchedulerEvent,
  Session
} from "../../../domain/index.js";
import { RepositoryBundle } from "../../store/repositories/index.js";
import { stripRuntimeSessionMetadata } from "../handlers/sessionState.js";

type SessionPatch = {
  phase?: DemandPhase;
  current_summary?: string;
  frontier_subgoal_ids?: string[];
  waiting_on?: string | null;
  latest_checkpoint?: string | null;
  last_progress_at?: string;
};

function createInitialSession(demand: Demand, event: SchedulerEvent<unknown>): Session {
  return {
    session_id: `session_${demand.demand_id}`,
    demand_id: demand.demand_id,
    phase: demand.current_phase,
    current_summary: demand.clarified_demand ?? demand.initial_input ?? demand.title,
    frontier_subgoal_ids: [],
    waiting_on: null,
    latest_checkpoint: event.event_id,
    last_progress_at: event.created_at,
    status: demand.state,
    created_at: demand.created_at,
    updated_at: demand.updated_at
  };
}

function getInputKind(event: SchedulerEvent<unknown>): string | undefined {
  return (event.payload as { input_kind?: string }).input_kind;
}

function getReason(event: SchedulerEvent<unknown>): string | undefined {
  return (event.payload as { reason?: string }).reason;
}

function reduceSessionPatch(
  session: Session,
  demand: Demand,
  event: SchedulerEvent<unknown>
): SessionPatch | null {
  switch (event.event_type) {
    case EventType.USER_INPUT_RECEIVED: {
      const inputKind = getInputKind(event);
      if (inputKind === "initial_demand") {
        const waitingOn = demand.metadata?.clarification_question ? "user_clarification" : null;
        return {
          phase: DemandPhase.ALIGNMENT,
          waiting_on: waitingOn,
          frontier_subgoal_ids: [],
          latest_checkpoint: event.event_id,
          current_summary: waitingOn ? "Initial demand needs clarification" : "Initial demand clarified"
        };
      }
      if (inputKind === "clarification_reply") {
        const waitingOn = demand.metadata?.clarification_question ? "user_clarification" : null;
        return {
          phase: DemandPhase.ALIGNMENT,
          waiting_on: waitingOn,
          latest_checkpoint: event.event_id,
          current_summary: waitingOn ? "Clarification still needed" : "Clarification reply accepted"
        };
      }
      return {
        latest_checkpoint: event.event_id,
        current_summary: "User input received"
      };
    }

    case EventType.DEMAND_CLARIFICATION_COMPLETED:
      return {
        phase: DemandPhase.PLANNING,
        waiting_on: null,
        latest_checkpoint: event.event_id,
        current_summary: "Clarification completed"
      };

    case EventType.REPLAN_REQUESTED:
      return {
        phase: DemandPhase.PLANNING,
        waiting_on: "scheduler",
        latest_checkpoint: event.event_id,
        current_summary: `Replan requested: ${getReason(event) ?? "unspecified"}`
      };

    case EventType.PLAN_GENERATED: {
      const payload = event.payload as {
        frontier_subgoal_ids?: string[];
        high_level_summary?: {
          mission_state_summary?: string;
        };
      };
      return {
        phase: DemandPhase.PLANNING,
        waiting_on: null,
        frontier_subgoal_ids: payload.frontier_subgoal_ids ?? session.frontier_subgoal_ids,
        latest_checkpoint: event.event_id,
        current_summary: payload.high_level_summary?.mission_state_summary ?? "Frontier plan generated"
      };
    }

    case EventType.SUBGOAL_CREATED: {
      const payload = event.payload as { subgoal_contract?: { subgoal_id?: string; title?: string } };
      const subgoalId = payload.subgoal_contract?.subgoal_id ?? event.subgoal_id;
      const nextFrontier = subgoalId && !session.frontier_subgoal_ids.includes(subgoalId)
        ? [...session.frontier_subgoal_ids, subgoalId]
        : session.frontier_subgoal_ids;
      return {
        phase: DemandPhase.PLANNING,
        frontier_subgoal_ids: nextFrontier,
        latest_checkpoint: subgoalId ?? event.event_id,
        current_summary: payload.subgoal_contract?.title
          ? `Subgoal created: ${payload.subgoal_contract.title}`
          : "Subgoal created"
      };
    }

    case EventType.SUBGOAL_MARKED_READY:
      return {
        phase: DemandPhase.PLANNING,
        waiting_on: "scheduler",
        latest_checkpoint: event.subgoal_id ?? event.event_id,
        current_summary: event.subgoal_id ? `Subgoal ready: ${event.subgoal_id}` : "Subgoal ready"
      };

    case EventType.EXECUTION_CREATED:
    case EventType.EXECUTION_DISPATCHED:
      return {
        phase: DemandPhase.EXECUTION,
        waiting_on: "worker_result",
        latest_checkpoint: event.execution_id ?? event.event_id,
        current_summary: event.subgoal_id ? `Dispatched subgoal ${event.subgoal_id}` : "Execution dispatched"
      };

    case EventType.WORKER_HEARTBEAT_RECEIVED:
      return {
        phase: DemandPhase.EXECUTION,
        waiting_on: "worker_result",
        latest_checkpoint: event.execution_id ?? session.latest_checkpoint,
        current_summary: session.current_summary,
        last_progress_at: session.last_progress_at
      };

    case EventType.WORKER_RESULT_RECEIVED: {
      const status = (event.payload as { worker_result?: { worker_status?: string } }).worker_result?.worker_status;
      return {
        phase: DemandPhase.REVIEW,
        waiting_on: "verifier",
        latest_checkpoint: event.execution_id ?? event.event_id,
        current_summary: status ? `Worker result received: ${status}` : "Worker result received"
      };
    }

    case EventType.VERIFICATION_COMPLETED: {
      const status = (event.payload as { verification_result?: { verified_status?: string } }).verification_result?.verified_status;
      return {
        phase: DemandPhase.REVIEW,
        waiting_on: "scheduler",
        latest_checkpoint: event.execution_id ?? event.event_id,
        current_summary: status ? `Verification: ${status}` : "Verification completed"
      };
    }

    case EventType.RECONCILIATION_COMPLETED: {
      const payload = event.payload as {
        decision_id?: string | null;
        mission_completed?: boolean;
        replan_requested?: boolean;
        retry_requested?: boolean;
        verification_status?: string;
      };
      if (payload.decision_id) {
        return {
          phase: DemandPhase.REVIEW,
          waiting_on: "user_decision",
          latest_checkpoint: payload.decision_id,
          current_summary: `Decision required: ${payload.verification_status ?? "review"}`
        };
      }
      if (payload.mission_completed) {
        return {
          phase: DemandPhase.COMPLETED,
          waiting_on: null,
          latest_checkpoint: event.event_id,
          current_summary: "Mission completed"
        };
      }
      return {
        phase: payload.replan_requested ? DemandPhase.PLANNING : demand.current_phase,
        waiting_on: payload.replan_requested || payload.retry_requested ? null : "scheduler",
        latest_checkpoint: event.event_id,
        current_summary: payload.verification_status
          ? `Reconciled verification: ${payload.verification_status}`
          : "Reconciliation completed"
      };
    }

    case EventType.SUBGOAL_RETRY_REQUESTED: {
      const payload = event.payload as { retry_attempt?: number };
      return {
        phase: DemandPhase.REVIEW,
        waiting_on: "scheduler",
        latest_checkpoint: event.subgoal_id ?? event.event_id,
        current_summary: `Retry requested for subgoal${payload.retry_attempt ? `, attempt ${payload.retry_attempt}` : ""}`
      };
    }

    case EventType.DECISION_REQUEST_CREATED: {
      const request = (event.payload as { decision_request?: { decision_id?: string; reason_code?: string } }).decision_request;
      return {
        phase: DemandPhase.REVIEW,
        waiting_on: "user_decision",
        latest_checkpoint: request?.decision_id ?? event.decision_id ?? event.event_id,
        current_summary: `Decision required: ${request?.reason_code ?? "review"}`
      };
    }

    case EventType.DECISION_RESPONSE_RECEIVED: {
      const action = (event.payload as { decision_response?: { action?: DecisionAction } }).decision_response?.action;
      const stillWaiting = demand.active_decision_id ? "user_decision" : null;
      return {
        phase: demand.current_phase,
        waiting_on: stillWaiting,
        latest_checkpoint: event.decision_id ?? event.event_id,
        current_summary: action === DecisionAction.PROVIDE_INFO && stillWaiting
          ? "Decision conversation updated"
          : "Decision resolved"
      };
    }

    case EventType.DEMAND_PAUSED:
      return {
        phase: demand.current_phase,
        waiting_on: "resume",
        latest_checkpoint: event.event_id,
        current_summary: "Demand paused"
      };

    case EventType.DEMAND_RESUMED:
      return {
        phase: DemandPhase.PLANNING,
        waiting_on: null,
        latest_checkpoint: event.event_id,
        current_summary: "Demand resumed"
      };

    case EventType.DEMAND_CANCELLED:
      return {
        phase: DemandPhase.CANCELLED,
        waiting_on: null,
        latest_checkpoint: event.event_id,
        current_summary: "Demand cancelled"
      };

    case EventType.MISSION_COMPLETED:
      return {
        phase: DemandPhase.COMPLETED,
        waiting_on: null,
        latest_checkpoint: event.event_id,
        current_summary: (event.payload as { summary?: string }).summary ?? "Mission completed"
      };

    case EventType.EXECUTION_STOP_REQUESTED:
      return {
        phase: demand.current_phase,
        waiting_on: "scheduler",
        latest_checkpoint: event.execution_id ?? event.event_id,
        current_summary: "Execution stop requested"
      };

    case EventType.EXECUTION_TIMEOUT_DETECTED:
      return {
        phase: DemandPhase.REVIEW,
        waiting_on: "scheduler",
        latest_checkpoint: event.execution_id ?? event.event_id,
        current_summary: `Execution timeout: ${(event.payload as { reason?: string }).reason ?? "timeout"}`
      };

    case EventType.OPS_RECOVERY_ATTEMPTED: {
      const payload = event.payload as { next_execution_id?: string | null; strategy?: string };
      return {
        phase: payload.next_execution_id ? DemandPhase.EXECUTION : DemandPhase.REVIEW,
        waiting_on: payload.next_execution_id ? "worker_result" : "scheduler",
        latest_checkpoint: payload.next_execution_id ?? event.execution_id ?? event.event_id,
        current_summary: `Ops recovery attempted: ${payload.strategy ?? "recovery"}`
      };
    }

    case EventType.OPS_RECOVERY_FAILED:
      return {
        phase: DemandPhase.REVIEW,
        waiting_on: "ops",
        latest_checkpoint: event.event_id,
        current_summary: `Ops recovery failed: ${(event.payload as { code?: string }).code ?? "unknown"}`
      };

    case EventType.OPS_ALERT:
      return {
        phase: DemandPhase.REVIEW,
        waiting_on: "ops",
        latest_checkpoint: event.event_id,
        current_summary: `Ops alert: ${(event.payload as { code?: string }).code ?? "alert"}`
      };

    case EventType.WORKER_HEALTH_CHECKED:
      return null;

    default:
      return null;
  }
}

export function reduceSession(
  previousSession: Session | null | undefined,
  demand: Demand,
  event: SchedulerEvent<unknown>
): Session {
  const base = previousSession ?? createInitialSession(demand, event);
  const patch = reduceSessionPatch(base, demand, event);
  if (!patch) {
    return {
      ...base,
      status: demand.state,
      updated_at: demand.updated_at
    };
  }

  return {
    ...base,
    ...patch,
    status: demand.state,
    updated_at: demand.updated_at,
    last_progress_at: patch.last_progress_at ?? event.created_at
  };
}

export async function applySessionEvent(
  event: SchedulerEvent<unknown>,
  repositories: RepositoryBundle
): Promise<void> {
  if (!event.demand_id) {
    return;
  }

  const demand = await repositories.demands.getById(event.demand_id);
  if (!demand) {
    return;
  }

  const existingSession = await repositories.sessions.getById(`session_${event.demand_id}`);
  await repositories.sessions.upsert(reduceSession(existingSession, demand, event));

  if (demand.metadata?.runtime_session !== undefined) {
    await repositories.demands.upsert({
      ...demand,
      metadata: stripRuntimeSessionMetadata(demand.metadata)
    });
  }
}
