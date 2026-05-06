/**
 * 文件名称：shared.ts
 * 文件作用：事件处理器共享工具模块，提供事件载荷中常用实体引用的提取方法。
 *
 * 主要职责：
 * 1. 从调度事件中收集 demand_id、subgoal_id、execution_id 和 worker_id。
 * 2. 为日志记录、错误上下文和事件链追踪提供统一引用结构。
 *
 * 依赖模块：
 * - domain：调度事件类型。
 *
 * 注意事项：
 * - 本模块只做轻量解析，不应修改事件载荷。
 * - 新增常用实体引用字段时，可在这里统一补充。
 */
import { SchedulerEvent } from "../../../../domain/index.js";

/**
 * 函数作用：从事件载荷和引用字段中收集常用实体 ID。
 *
 * 参数说明：
 * - event：调度事件。
 *
 * 返回值：
 * - 返回包含 demandId、subgoalId、executionId 和 workerId 的引用对象。
 */
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
