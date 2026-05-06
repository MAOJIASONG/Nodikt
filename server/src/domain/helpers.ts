/**
 * 文件名称：helpers.ts
 * 文件作用：领域通用工具模块，提供时间、ID 和调度事件创建方法。
 *
 * 主要职责：
 * 1. 生成统一格式的 ISO 时间戳。
 * 2. 生成带业务前缀的唯一 ID。
 * 3. 按事件类型创建标准 SchedulerEvent 对象。
 *
 * 依赖模块：
 * - domain/enums：事件类型枚举。
 * - domain/types：事件载荷与调度事件类型定义。
 *
 * 注意事项：
 * - 事件创建逻辑应保持轻量，复杂状态变更交由事件处理器完成。
 * - ID 前缀应体现业务实体类型，便于排查和人工阅读。
 */
import { EventType } from "./enums.js";
import { EventPayloadMap, SchedulerEvent } from "./types.js";

/**
 * 函数作用：生成当前时间的 ISO 字符串。
 *
 * 参数说明：
 * - 无。
 *
 * 返回值：
 * - string：当前时间的 ISO 8601 格式字符串。
 */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 函数作用：生成带业务前缀的唯一 ID。
 *
 * 参数说明：
 * - prefix：ID 前缀，用于标识实体类型。
 *
 * 返回值：
 * - string：由前缀、时间戳和随机片段组成的 ID。
 */
export function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 函数作用：创建标准调度事件对象。
 *
 * 参数说明：
 * - type：事件类型。
 * - payload：事件载荷，必须与事件类型匹配。
 * - refs：可选实体引用，用于关联需求、子目标、执行和工作器。
 *
 * 返回值：
 * - SchedulerEvent：包含统一 ID、时间戳、类型、载荷和实体引用的事件。
 */
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
