import { SubgoalState } from "../domain/index.js";

type PlanOutlineItem = {
  plan_item_id: string;
  frontier_subgoal_ids?: string[];
};

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

export function collectUnlockedPlannedSubgoals(
  demand: { metadata?: Record<string, unknown> | undefined },
  subgoals: Array<{ subgoal_id: string; state: SubgoalState }>
): string[] {
  return subgoals
    .filter((item) => item.state === SubgoalState.PLANNED)
    .filter((item) => isSubgoalUnlockedByPlan(demand, item.subgoal_id, subgoals))
    .map((item) => item.subgoal_id);
}
