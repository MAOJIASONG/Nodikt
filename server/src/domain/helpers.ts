import { EventType } from "./enums.js";
import { EventPayloadMap, SchedulerEvent } from "./types.js";

export function nowIso(): string {
  return new Date().toISOString();
}

export function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function createEvent<T extends EventType>(
  eventType: T,
  payload: EventPayloadMap[T],
  refs: Partial<Omit<SchedulerEvent, "event_type" | "event_id" | "payload" | "created_at">> = {}
): SchedulerEvent<EventPayloadMap[T]> {
  return {
    event_id: createId("evt"),
    event_type: eventType,
    payload,
    created_at: nowIso(),
    demand_id: refs.demand_id ?? null,
    subgoal_id: refs.subgoal_id ?? null,
    execution_id: refs.execution_id ?? null,
    decision_id: refs.decision_id ?? null,
    worker_id: refs.worker_id ?? null
  };
}
