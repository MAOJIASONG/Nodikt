/**
 * 文件名称：planProgress.ts
 * 文件作用：计划进度辅助模块，负责读取计划大纲并判断子目标解锁关系。
 *
 * 主要职责：
 * 1. 从需求元数据中读取计划大纲。
 * 2. 判断指定子目标是否满足前置依赖。
 * 3. 收集因前置完成而新解锁的计划子目标。
 *
 * 依赖模块：
 * - domain：子目标状态枚举。
 *
 * 注意事项：
 * - 本模块只处理计划结构判断，不直接修改仓储状态。
 * - 计划大纲元数据格式变化时，需要同步调整读取逻辑。
 */
import { SubgoalState } from "../../../domain/index.js";

type PlanOutlineItem = {
  plan_item_id: string;
  frontier_subgoal_ids?: string[];
};

/**
 * 函数作用：从需求元数据中读取计划大纲。
 *
 * 参数说明：
 * - demand：包含 metadata 的需求对象。
 *
 * 返回值：
 * - PlanOutlineItem[]：计划大纲项列表，缺失或格式不正确时返回空数组。
 */
export function readPlanOutline(demand: { metadata?: Record<string, unknown> | undefined }): PlanOutlineItem[] {
  const latestPlan = demand.metadata?.latest_plan as { overall_plan_outline?: PlanOutlineItem[] } | undefined;
  return Array.isArray(latestPlan?.overall_plan_outline) ? latestPlan!.overall_plan_outline : [];
}

function findPlanItemIndexBySubgoalId(
  planOutline: PlanOutlineItem[],
  subgoalId: string
): number {
  return planOutline.findIndex((item) => (
    Array.isArray(item.frontier_subgoal_ids) && item.frontier_subgoal_ids.includes(subgoalId)
  ));
}

/**
 * 函数作用：判断计划中的子目标是否已满足解锁条件。
 *
 * 参数说明：
 * - demand：所属需求。
 * - subgoalId：待判断的子目标 ID。
 * - subgoals：当前已有子目标列表。
 *
 * 返回值：
 * - boolean：满足前置条件时返回 true。
 */
export function isSubgoalUnlockedByPlan(
  demand: { metadata?: Record<string, unknown> | undefined },
  subgoalId: string,
  subgoals: Array<{ subgoal_id: string; state: SubgoalState }>
): boolean {
  const planOutline = readPlanOutline(demand);
  const itemIndex = findPlanItemIndexBySubgoalId(planOutline, subgoalId);

  if (itemIndex <= 0) {
    return true;
  }

  for (const priorItem of planOutline.slice(0, itemIndex)) {
    const ids = Array.isArray(priorItem.frontier_subgoal_ids) ? priorItem.frontier_subgoal_ids : [];
    if (ids.length === 0) {
      continue;
    }

    const hasCompletedPriorSubgoal = ids.some((candidateId) => (
      subgoals.some((candidate) => candidate.subgoal_id === candidateId && candidate.state === SubgoalState.DONE)
    ));

    if (!hasCompletedPriorSubgoal) {
      return false;
    }
  }

  return true;
}

/**
 * 函数作用：收集因为前置完成而新解锁的计划子目标。
 *
 * 参数说明：
 * - demand：所属需求。
 * - completedSubgoalId：刚完成的子目标 ID。
 * - subgoals：当前已有子目标列表。
 *
 * 返回值：
 * - SubgoalContract[]：可被标记为就绪的子目标列表。
 */
export function collectUnlockedPlannedSubgoals(
  demand: { metadata?: Record<string, unknown> | undefined },
  subgoals: Array<{ subgoal_id: string; state: SubgoalState }>
): string[] {
  return subgoals
    .filter((item) => item.state === SubgoalState.PLANNED)
    .filter((item) => isSubgoalUnlockedByPlan(demand, item.subgoal_id, subgoals))
    .map((item) => item.subgoal_id);
}
