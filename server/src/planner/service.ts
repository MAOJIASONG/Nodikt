import {
  Demand,
  EventReason,
  OperationalObjective,
  PlanGeneratedPayload,
  Settings,
  SubgoalContract,
  SubgoalState,
  createId,
  nowIso
} from "../domain/index.js";
import { LlmClient } from "../llm/index.js";

type ClarifiedDemandResult = {
  status: "NEEDS_CLARIFICATION" | "READY";
  display_title?: string;
  clarification_question?: string;
  clarified_demand?: string;
  operational_objective?: OperationalObjective;
  clarification_summary?: string;
};

type FrontierPlanResult = {
  overall_plan_outline: Array<{
    title: string;
    objective: string;
    execution_mode: "parallel" | "sequential";
    rationale: string;
    frontier_subgoal_indexes?: number[];
  }>;
  frontier_subgoals: Array<{
    title: string;
    objective: string;
    success_criteria: string[];
    failure_criteria: string[];
    constraints: string[];
    deliverables: unknown[];
  }>;
  mission_state_summary: string;
  episodic_trace_summary: string;
  lessons_or_policy_summary: string;
};

type ExecutionGuidanceNote = {
  source?: string;
  note?: string;
  created_at?: string;
};

const ALLOWED_DELIVERABLES = new Set([
  "git_commit",
  "pull_request",
  "file_bundle",
  "structured_output_json"
] as const);

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}

function normalizeDeliverables(value: unknown): Array<"git_commit" | "pull_request" | "file_bundle" | "structured_output_json"> {
  if (!Array.isArray(value)) {
    return ["file_bundle"];
  }

  const normalized = value
    .map((item) => {
      if (typeof item === "string" && ALLOWED_DELIVERABLES.has(item as any)) {
        return item as "git_commit" | "pull_request" | "file_bundle" | "structured_output_json";
      }

      if (item && typeof item === "object") {
        const typed = item as Record<string, unknown>;
        if (typeof typed.artifact_type === "string" && ALLOWED_DELIVERABLES.has(typed.artifact_type as any)) {
          return typed.artifact_type as "git_commit" | "pull_request" | "file_bundle" | "structured_output_json";
        }
        if (typeof typed.file_path === "string") {
          return "file_bundle";
        }
      }

      return null;
    })
    .filter((item): item is "git_commit" | "pull_request" | "file_bundle" | "structured_output_json" => Boolean(item));

  return normalized.length > 0 ? Array.from(new Set(normalized)) : ["file_bundle"];
}

function readExecutionGuidance(metadata?: Record<string, unknown>): ExecutionGuidanceNote[] {
  const raw = metadata?.execution_guidance;
  return Array.isArray(raw) ? raw as ExecutionGuidanceNote[] : [];
}

export class PlannerService {
  constructor(private readonly llmClient: LlmClient) {}

  async clarifyDemand(input: {
    rawInput: string;
    settings: Settings;
  }): Promise<ClarifiedDemandResult> {
    const result = await this.llmClient.generateJson<ClarifiedDemandResult>({
      settings: input.settings,
      role: "planner",
      temperature: 0.1,
      maxTokens: 6000,
      systemPrompt: [
        "You are the clarification assistant for Nodikt v1.",
        "Return valid JSON only.",
        "First decide whether the demand is sufficiently clarified.",
        "Treat clarification as a short conversation inside a demand, not as one-shot form filling.",
        "Ask concise, high-signal follow-up questions when key execution context is still missing.",
        "Prefer one focused clarification question at a time.",
        "If this is a coding or repository task and the project/workspace path is missing or ambiguous, you must ask for it before marking READY.",
        "Do not change the user's goal semantics.",
        "Schema:",
        JSON.stringify({
          status: "NEEDS_CLARIFICATION | READY",
          display_title: "short product-style title, ideally 3-8 words",
          clarification_question: "string when clarification is needed",
          clarified_demand: "string when ready",
          operational_objective: {
            objective: "string",
            acceptance_criteria: ["string"],
            constraints: ["string"],
            non_goals: ["string"],
            termination_conditions: ["string"]
          },
          clarification_summary: "string when ready"
        })
      ].join("\n"),
      userPrompt: `User demand:\n${input.rawInput}`
    });

    if (result.status === "NEEDS_CLARIFICATION") {
      return {
        status: "NEEDS_CLARIFICATION",
        display_title: result.display_title?.trim(),
        clarification_question: result.clarification_question?.trim() || "Please provide the missing project/workspace path and key constraints."
      };
    }

    if (!result.operational_objective || !result.clarified_demand || !result.clarification_summary) {
      throw new Error("LLM clarification returned READY without complete objective payload");
    }

    return {
      status: "READY",
      display_title: result.display_title?.trim(),
      clarified_demand: result.clarified_demand.trim(),
      operational_objective: {
        objective: result.operational_objective.objective.trim(),
        acceptance_criteria: normalizeStringArray(result.operational_objective.acceptance_criteria),
        constraints: normalizeStringArray(result.operational_objective.constraints),
        non_goals: normalizeStringArray(result.operational_objective.non_goals),
        termination_conditions: normalizeStringArray(result.operational_objective.termination_conditions)
      },
      clarification_summary: result.clarification_summary.trim()
    };
  }

  async generateFrontierPlan(
    demand: Demand,
    reason: EventReason,
    planningRound: number,
    settings: Settings
  ): Promise<{
    subgoals: SubgoalContract[];
    payload: PlanGeneratedPayload;
  }> {
    const result = await this.llmClient.generateJson<FrontierPlanResult>({
      settings,
      role: "planner",
      temperature: 0.2,
      maxTokens: 10000,
      systemPrompt: [
        "You are the frontier-only planner for Nodikt v1.",
        "Return valid JSON only.",
        "Produce a complete high-level overall plan outline for display.",
        "Also produce the current frontier subgoals that can execute now.",
        "The frontier subgoals must all be same-level, independent, and safe to run in parallel when possible.",
        "Prefer 2-3 frontier subgoals for medium or large coding tasks. Use 1 if the task is truly small or highly sequential.",
        "Do not include blocked later-stage tasks in frontier_subgoals.",
        "Do not mutate the demand objective.",
        "Schema:",
        JSON.stringify({
          overall_plan_outline: [
            {
              title: "string",
              objective: "string",
              execution_mode: "parallel | sequential",
              rationale: "string",
              frontier_subgoal_indexes: [0]
            }
          ],
          frontier_subgoals: [
            {
              title: "string",
              objective: "string",
              success_criteria: ["string"],
              failure_criteria: ["string"],
              constraints: ["string"],
              deliverables: ["file_bundle"]
            }
          ],
          mission_state_summary: "string",
          episodic_trace_summary: "string",
          lessons_or_policy_summary: "string"
        })
      ].join("\n"),
      userPrompt: [
        `Demand title: ${demand.title}`,
        `Clarified demand: ${demand.clarified_demand ?? demand.initial_input}`,
        `Operational objective: ${JSON.stringify(demand.operational_objective)}`,
        `Recent execution guidance from user: ${JSON.stringify(readExecutionGuidance(demand.metadata).slice(-6))}`,
        `Planning round: ${planningRound}`,
        `Reason: ${reason}`
      ].join("\n")
    });

    const timestamp = nowIso();
    const frontierSubgoals = Array.isArray(result.frontier_subgoals) ? result.frontier_subgoals : [];
    const subgoals: SubgoalContract[] = frontierSubgoals.slice(0, 3).map((item, index) => ({
      subgoal_id: createId("subgoal"),
      demand_id: demand.demand_id,
      title: item.title.trim(),
      objective: item.objective.trim(),
      success_criteria: normalizeStringArray(item.success_criteria),
      failure_criteria: normalizeStringArray(item.failure_criteria),
      constraints: normalizeStringArray(item.constraints),
      budget: {
        max_steps: 20,
        max_minutes: 15
      },
      deliverables: normalizeDeliverables(item.deliverables),
      dependencies: [],
      priority: index + 1,
      state: SubgoalState.PLANNED,
      planning_round: planningRound,
      created_at: timestamp,
      updated_at: timestamp
    }));

    if (subgoals.length === 0) {
      throw new Error("Planner returned no frontier subgoals");
    }

    const overallPlanOutline = (Array.isArray(result.overall_plan_outline) ? result.overall_plan_outline : [])
      .map((item, index) => {
        const mappedIndexes = Array.isArray(item.frontier_subgoal_indexes)
          ? item.frontier_subgoal_indexes.filter((value): value is number => Number.isInteger(value) && value >= 0 && value < subgoals.length)
          : [];
        const fallbackIndexes = mappedIndexes.length > 0
          ? mappedIndexes
          : index === 0
            ? subgoals.map((_subgoal, subgoalIndex) => subgoalIndex)
            : [];

        return {
          plan_item_id: `plan_${planningRound}_${index + 1}`,
          title: item.title.trim(),
          objective: item.objective.trim(),
          execution_mode: (item.execution_mode === "parallel" ? "parallel" : "sequential") as "parallel" | "sequential",
          rationale: item.rationale.trim(),
          frontier_subgoal_ids: Array.from(new Set(fallbackIndexes.map((subgoalIndex) => subgoals[subgoalIndex]?.subgoal_id).filter((value): value is string => Boolean(value))))
        };
      });

    return {
      subgoals,
      payload: {
        planning_round: planningRound,
        dependency_graph_snapshot: {
          frontier: subgoals.map((item) => item.subgoal_id),
          planner_reason: reason
        },
        frontier_subgoal_ids: subgoals.map((item) => item.subgoal_id),
        overall_plan_outline: overallPlanOutline,
        high_level_summary: {
          mission_state_summary: result.mission_state_summary,
          episodic_trace_summary: result.episodic_trace_summary,
          lessons_or_policy_summary: result.lessons_or_policy_summary
        },
        reason
      }
    };
  }
}
