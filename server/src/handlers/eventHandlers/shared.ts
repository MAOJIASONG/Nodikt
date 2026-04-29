import { SchedulerEvent } from "../../domain/index.js";

export function collectEventRefs(event: SchedulerEvent): {
  demand_id?: string | null;
  subgoal_id?: string | null;
  execution_id?: string | null;
  worker_id?: string | null;
  decision_id?: string | null;
} {
  return {
    demand_id: event.demand_id,
    subgoal_id: event.subgoal_id,
    execution_id: event.execution_id,
    worker_id: event.worker_id,
    decision_id: event.decision_id
  };
}
