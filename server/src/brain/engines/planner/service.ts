/**
 * 文件名称：service.ts
 * 文件作用：规划服务模块，负责将用户需求澄清、拆解并生成可执行的子目标计划。
 *
 * 主要职责：
 * 1. 调用 LLM 完成需求澄清和前沿计划生成。
 * 2. 将模型计划转换为 SubgoalContract 列表。
 * 3. 根据执行反馈和决策结果生成重规划方案。
 * 4. 维护计划产物、执行指导和需求元数据之间的关系。
 *
 * 依赖模块：
 * - domain：需求、子目标、执行和产物类型。
 * - logger：规划服务日志。
 * - brain/engines/llm：模型调用客户端。
 *
 * 注意事项：
 * - 模型返回内容需要做容错归一化，避免脏数据进入调度状态机。
 * - 计划输出必须保持可执行、可验证和可追踪。
 */
import {
  Demand,
  EventReason,
  OperationalObjective,
  PlanGeneratedPayload,
  Settings,
  Session,
  SubgoalContract,
  SubgoalState,
  createId,
  nowIso
} from "../../../domain/index.js";
import { createLogger } from "../../../logger.js";
import { LlmClient, LlmInvocationError } from "../llm/index.js";

/**
 * Clarifier 三档判断结果：
 * - NEEDS_CLARIFICATION：缺的是用户偏好/决定/目标，只能问用户。
 * - NEEDS_RECON：缺的是事实/文件/状态，可以派 read-only worker 自己去看。
 * - READY：信息足够，可以编译出 operational_objective 进入 planner。
 */
export type ReconSubgoalDraft = {
  title: string;
  objective: string;
  success_criteria: string[];
  failure_criteria?: string[];
  constraints?: string[];
};

type ClarifiedDemandResult = {
  status: "NEEDS_CLARIFICATION" | "NEEDS_RECON" | "READY";
  display_title?: string;
  clarification_question?: string;
  recon_subgoals?: ReconSubgoalDraft[];
  recon_rationale?: string;
  clarified_demand?: string;
  operational_objective?: OperationalObjective;
  clarification_summary?: string;
  /**
   * 用户在 demand 文本里明确指定的输出目录（绝对路径）。如果用户没指定就是 undefined。
   * demandHandlers 在 READY 分支据此判断是否需要 PATH_GRANT_REQUIRED 决策。
   */
  workspace_override?: string | null;
  /** 当 LLM 调用本身失败被 clarifier 兜底降级为 NEEDS_CLARIFICATION 时，这里附带原始错误，供 handler stamp brain_error。 */
  llm_error?: {
    message: string;
    error_name: string;
  };
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
    /**
     * "build"（默认）：执行型，产出 artifact/状态变更。
     * "recon"：侦察型，只读不写。模型在信息不足以编出 build plan 时应输出 recon。
     */
    kind?: "build" | "recon";
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

export type ReplanRuntimeContext = {
  session?: Session | null;
  recent_events?: Array<{
    event_type: string;
    created_at: string;
    subgoal_id?: string | null;
    execution_id?: string | null;
    decision_id?: string | null;
    summary?: Record<string, unknown>;
  }>;
  recent_executions?: Array<{
    execution_id: string;
    subgoal_id: string;
    state: string;
    result_status?: string | null;
    claimed_outcome?: string | null;
    updated_at: string;
  }>;
  recent_memory?: Array<{
    category: string;
    content: string;
    created_at?: string;
  }>;
};

const ALLOWED_DELIVERABLES = new Set([
  "git_commit",
  "pull_request",
  "file_bundle",
  "structured_output_json"
] as const);
const logger = createLogger("planner");

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

function compactRuntimeContext(context?: ReplanRuntimeContext): ReplanRuntimeContext | null {
  if (!context) {
    return null;
  }
  return {
    session: context.session ?? null,
    recent_events: context.recent_events?.slice(-20) ?? [],
    recent_executions: context.recent_executions?.slice(-10) ?? [],
    recent_memory: context.recent_memory?.slice(-8) ?? []
  };
}

export class PlannerService {
  constructor(private readonly llmClient: LlmClient) {}

  /**
   * 函数作用：澄清用户原始需求并生成可调度的业务目标。
   *
   * 参数说明：
   * - input.demand：待澄清的需求实体。
   * - input.settings：模型调用设置。
   *
   * 返回值：
   * - Promise<ClarifiedDemandResult>：包含澄清文本、标题和 operational_objective 的结果。
   */
  async clarifyDemand(input: {
    rawInput: string;
    settings: Settings;
  }): Promise<ClarifiedDemandResult> {
    const systemPrompt = [
      "You are the clarification assistant for Nodikt v1.",
      "Return valid JSON only.",
      "Treat clarification as a short conversation inside a demand, not as one-shot form filling.",
      "Do not change the user's goal semantics.",
      "",
      "## You have THREE possible decisions",
      "",
      '1. "NEEDS_CLARIFICATION" — Ask the user. Use this whenever a DECISION the user should own is still open:',
      "   their goals, success criteria / what \"done\" looks like, scope boundaries, priorities and trade-offs,",
      "   a technical or design choice that has several reasonable answers, business choices, brand-new artifacts",
      "   they want, decisions you cannot make for them.",
      "   If reaching READY would mean guessing a default that silently commits the user to a direction they",
      "   never chose — ask instead. Your job here is to draw the important details OUT of the user before planning,",
      "   not to fill the gaps yourself.",
      "",
      '2. "NEEDS_RECON" — Dispatch a read-only worker to investigate. Use this when the gap is',
      "   FACTUAL information that a worker can observe directly without bothering the user.",
      "   The recon worker has access to ANY read-only / observational tool: local file inspection",
      "   (Read / Glob / Grep / ls / cat / git status), Web lookup (WebFetch / WebSearch),",
      "   read-only HTTP / API queries, and even delegated sub-investigations (Task).",
      "   It cannot write or mutate anything — locally or remotely.",
      "",
      "   DO NOT ask the user for facts that a worker can simply look up. Asking the user for things",
      "   the system can observe itself is the wrong choice.",
      "   But recon is for FACTS only — never use it to settle a decision the user should make.",
      "   Finding WHERE the auth module lives is recon; deciding WHAT the new feature should actually do is clarification.",
      "",
      "   Examples that should be NEEDS_RECON:",
      "     * \"Refactor this repo\" without specifying which files — recon the repo structure.",
      "     * \"The tank game in server/workspace\" — recon the directory to see what's there.",
      "     * \"Add a test for the auth module\" — recon to find where the auth module lives.",
      "     * \"Migrate to React 19\" — recon official React 19 migration docs (WebFetch / WebSearch).",
      "     * \"Use the latest OpenAI API\" — recon the current API spec online.",
      "     * Anything that asks for behavior consistent with an EXTERNAL reference whose current state we should check.",
      "",
      "   When choosing NEEDS_RECON, output 1-3 `recon_subgoals`. For each, write a concrete read-only objective",
      "   that hints at what kind of inspection is needed.",
      "",
      '3. "READY" — Information is sufficient. Compile an operational_objective and move to planning.',
      "    When you choose READY, ALL of these fields MUST be non-empty strings (and operational_objective",
      "    a complete object). Leaving any of them blank is a contract violation — re-emit the whole payload:",
      "      - clarified_demand",
      "      - clarification_summary",
      "      - operational_objective.objective",
      "      - operational_objective.{acceptance_criteria, constraints, non_goals, termination_conditions}",
      "        (arrays — may be empty `[]` but must be present)",
      "",
      "## Rules of thumb",
      "- Separate the two kinds of gaps. A FACTUAL gap (where a file lives, repo structure, an external doc's current state) → NEEDS_RECON. A DECISION gap (goal, scope, acceptance criteria, choosing between reasonable approaches — anything the user should own) → NEEDS_CLARIFICATION.",
      "- Bias toward NEEDS_CLARIFICATION for decision gaps. Do NOT reach READY by filling a decision gap with a plausible default — if the user hasn't told you and you'd be guessing what they want, ask.",
      "- Reserve READY for when the decisions are genuinely settled: the user stated them, or there is only one reasonable interpretation. If you catch yourself inventing acceptance criteria or picking an approach the user never mentioned, that's NEEDS_CLARIFICATION, not READY.",
      "- Facts the user didn't give but a worker can observe are still NEEDS_RECON — don't bother the user for those.",
      "- Never combine NEEDS_CLARIFICATION and NEEDS_RECON in the same response — choose the most informative single next step.",
      "",
      "## Workspace override — IMPORTANT",
      "If the user explicitly tells you WHERE to put the output (an absolute filesystem path like",
      "`/home/user/projects/myapp` or `/volume/.../some-dir`), extract that path into the",
      "`workspace_override` field — verbatim, just the directory path, no quotes, no surrounding text.",
      "Rules:",
      "- Only set this when the user names a directory (absolute path) as the destination. Don't guess.",
      "- Trim trailing slashes.",
      "- Leave it null/omit when the user did not specify an output location — the system has a default workspace.",
      "- It's perfectly valid for a READY response to omit workspace_override.",
      "- If the user says 'in my project folder' without giving the actual path, that's NEEDS_CLARIFICATION (ask for the path) — not workspace_override.",
      "",
      "## Schema",
      JSON.stringify({
        status: "NEEDS_CLARIFICATION | NEEDS_RECON | READY",
        display_title: "short product-style title, ideally 3-8 words",
        clarification_question: "string — set when status is NEEDS_CLARIFICATION. Guide the user: don't ask a vague 'please add more detail'. Briefly restate what you DID understand, then lay out the specific open decisions as a short list (e.g. '1) scope: A or B? 2) what does done look like? 3) any constraints?'). Make it easy to answer — offer concrete options where reasonable. Ask only what's needed to plan well; don't interrogate.",
        recon_subgoals: [
          {
            title: "Brief title for what to inspect",
            objective: "Concrete read-only task, e.g. 'List server/workspace contents and read top-level files'",
            success_criteria: ["What information must be returned"],
            failure_criteria: ["Optional"],
            constraints: ["Optional, e.g. 'Do not read files larger than 200KB'"]
          }
        ],
        recon_rationale: "One short sentence explaining why recon is preferable to asking the user",
        clarified_demand: "string — set when status is READY",
        operational_objective: {
          objective: "string",
          acceptance_criteria: ["string"],
          constraints: ["string"],
          non_goals: ["string"],
          termination_conditions: ["string"]
        },
        clarification_summary: "string — set when status is READY",
        workspace_override: "absolute path string — set when the user named a specific output directory; otherwise omit / null"
      })
    ].join("\n");
    const baseUserPrompt = `User demand:\n${input.rawInput}`;

    // 抽出 LLM 调用，extraGuidance 不为 null 时用于 retry —— 把"上次缺了哪几个字段"作为
    // 强提示拼到 userPrompt 末尾，请求模型重发完整 READY payload。
    const callLlm = (extraGuidance: string | null): Promise<ClarifiedDemandResult> =>
      this.llmClient.generateJson<ClarifiedDemandResult>({
        settings: input.settings,
        role: "planner",
        temperature: 0.1,
        maxTokens: 6000,
        systemPrompt,
        userPrompt: extraGuidance
          ? `${baseUserPrompt}\n\n## CRITICAL FIX REQUIRED\n${extraGuidance}`
          : baseUserPrompt
      });

    // 返回当前 result 在 READY contract 下缺哪些字段；空数组代表完整。
    const findMissingReadyFields = (raw: ClarifiedDemandResult): string[] => {
      const missing: string[] = [];
      if (!raw.operational_objective) missing.push("operational_objective");
      if (typeof raw.clarified_demand !== "string" || !raw.clarified_demand.trim()) missing.push("clarified_demand");
      if (typeof raw.clarification_summary !== "string" || !raw.clarification_summary.trim()) missing.push("clarification_summary");
      if (typeof raw.operational_objective?.objective !== "string" || !raw.operational_objective.objective.trim()) {
        missing.push("operational_objective.objective");
      }
      return missing;
    };

    let result: ClarifiedDemandResult;
    try {
      result = await callLlm(null);
    } catch (error) {
      if (!(error instanceof LlmInvocationError)) {
        throw error;
      }
      logger.warn({ err: error }, "Planner clarification JSON failed; falling back to user clarification");
      const detail = (error.message ?? "").slice(0, 300);
      const isAuth = /\b401\b|invalid[_ ]?api[_ ]?key|invalid access token|token expired|unauthor/i.test(detail);
      const isQuota = /\b429\b|rate[_ ]?limit|quota|insufficient_quota/i.test(detail);
      const isNetwork = /ECONN|ENOTFOUND|ETIMEDOUT|abort|fetch failed|network/i.test(detail);
      let prefix = "Planner LLM call failed";
      if (isAuth) {
        prefix = "Planner LLM rejected the API key (401 / invalid token). Update Settings → models with a fresh key";
      } else if (isQuota) {
        prefix = "Planner LLM hit a rate limit / quota (429). Wait or switch model in Settings";
      } else if (isNetwork) {
        prefix = "Planner LLM call could not reach the model endpoint (network / timeout). Check base_url and network";
      } else if (/not valid JSON|No JSON object found|returned empty/i.test(detail)) {
        prefix = "Planner LLM returned no parseable JSON. Lower temperature or pick a JSON-capable model";
      }
      return {
        status: "NEEDS_CLARIFICATION",
        display_title: input.rawInput.trim().slice(0, 60) || "New Demand",
        clarification_question: `${prefix}. Underlying error: ${detail}`,
        llm_error: {
          message: error.message ?? String(error),
          error_name: error.name ?? "LlmInvocationError"
        }
      };
    }

    // READY 但 schema 不全是已知的 LLM 抖动（M2.5 在长 prompt + 多轮 recon 后偶发只回 summary 不回
    // clarified_demand / operational_objective）。这种情况自动 retry 一次，把"缺了哪几个字段"作为
    // 强指令塞回 prompt；retry 还不行再降级问用户。
    if (result.status === "READY") {
      const missing = findMissingReadyFields(result);
      if (missing.length > 0) {
        logger.warn({ missing }, "Clarifier 返回 READY 但 payload 不完整，尝试 retry 一次");
        try {
          const guidance = [
            `Your previous response had status="READY" but OMITTED these required fields: ${missing.join(", ")}.`,
            "When status is READY, you MUST emit the entire READY payload — re-emit the WHOLE JSON now:",
            "  - status: \"READY\"",
            "  - display_title: short product-style title",
            "  - clarified_demand: the user's goal rewritten as one paragraph (non-empty string)",
            "  - clarification_summary: one or two sentences explaining what was clarified (non-empty string)",
            "  - operational_objective: {",
            "      objective: a single-sentence buildable objective (non-empty string),",
            "      acceptance_criteria: string[] (use [] if none),",
            "      constraints: string[] (use [] if none),",
            "      non_goals: string[] (use [] if none),",
            "      termination_conditions: string[] (use [] if none)",
            "    }",
            "  - workspace_override: absolute path string or null",
            "Do NOT change your decision. Do NOT skip any field. Output the complete READY JSON only."
          ].join("\n");
          const retried = await callLlm(guidance);
          if (retried.status === "READY" && findMissingReadyFields(retried).length === 0) {
            logger.info("Clarifier retry 成功，使用补全后的 READY payload");
            result = retried;
          } else if (retried.status === "NEEDS_CLARIFICATION") {
            // Retry 时模型改主意了，照它说的问用户
            logger.info("Clarifier retry 后改为 NEEDS_CLARIFICATION，转发给用户");
            return {
              status: "NEEDS_CLARIFICATION",
              display_title: retried.display_title?.trim(),
              clarification_question: retried.clarification_question?.trim()
                || "I need a bit more from you to finalize the plan — could you confirm the objective and any constraints?"
            };
          } else {
            // 仍是 READY 但还缺字段、或换成 NEEDS_RECON 又没给 subgoals —— 降级问用户
            logger.warn({
              retriedStatus: retried.status,
              stillMissing: retried.status === "READY" ? findMissingReadyFields(retried) : null
            }, "Clarifier retry 后仍无法得到完整 READY，降级问用户");
            return {
              status: "NEEDS_CLARIFICATION",
              display_title: result.display_title?.trim() ?? retried.display_title?.trim(),
              clarification_question: "I have enough context to plan but couldn't compile the objective automatically. Could you state the objective in one sentence + any must/must-not constraints?"
            };
          }
        } catch (retryError) {
          logger.warn({ err: retryError, missing }, "Clarifier retry 调用本身失败，降级问用户");
          const retryErr = retryError instanceof Error ? retryError : new Error(String(retryError));
          return {
            status: "NEEDS_CLARIFICATION",
            display_title: result.display_title?.trim(),
            clarification_question: "I have enough context to plan but the model call to finalize it failed. Could you state the objective in one sentence + any must/must-not constraints?",
            llm_error: {
              message: retryErr.message ?? String(retryErr),
              error_name: retryErr.name ?? "LlmInvocationError"
            }
          };
        }
      }
    }

    if (result.status === "NEEDS_CLARIFICATION") {
      return {
        status: "NEEDS_CLARIFICATION",
        display_title: result.display_title?.trim(),
        clarification_question: result.clarification_question?.trim() || "Please provide the missing project/workspace path and key constraints."
      };
    }

    if (result.status === "NEEDS_RECON") {
      const rawSubgoals = Array.isArray(result.recon_subgoals) ? result.recon_subgoals : [];
      const cleanedSubgoals = rawSubgoals
        .filter((sg): sg is ReconSubgoalDraft => Boolean(sg && typeof sg === "object" && sg.title && sg.objective))
        .slice(0, 3)
        .map((sg) => ({
          title: sg.title.trim(),
          objective: sg.objective.trim(),
          success_criteria: normalizeStringArray(sg.success_criteria),
          failure_criteria: normalizeStringArray(sg.failure_criteria ?? []),
          constraints: normalizeStringArray(sg.constraints ?? [])
        }));
      if (cleanedSubgoals.length === 0) {
        logger.warn({ raw: result }, "Clarifier 标记 NEEDS_RECON 但未提供有效的 recon_subgoals，降级为问用户");
        return {
          status: "NEEDS_CLARIFICATION",
          display_title: result.display_title?.trim(),
          clarification_question: "Need more information to proceed but couldn't determine what to inspect. Please specify the target path or what you'd like me to check."
        };
      }
      return {
        status: "NEEDS_RECON",
        display_title: result.display_title?.trim(),
        recon_subgoals: cleanedSubgoals,
        recon_rationale: result.recon_rationale?.trim() ?? "Investigating environment to plan accurately"
      };
    }

    // READY 分支需要的字段：clarified_demand / clarification_summary / operational_objective.objective
    // 这三项任一缺失或非字符串都不能让 .trim() 直接抛 TypeError —— 它会把整条 recon→clarifier 链路
    // 静默中断。降级成 NEEDS_CLARIFICATION 让用户补充。
    const readyClarifiedDemand = typeof result.clarified_demand === "string" ? result.clarified_demand.trim() : "";
    const readyClarificationSummary = typeof result.clarification_summary === "string" ? result.clarification_summary.trim() : "";
    const readyObjectiveText = typeof result.operational_objective?.objective === "string"
      ? result.operational_objective.objective.trim()
      : "";

    if (!result.operational_objective || !readyClarifiedDemand || !readyClarificationSummary || !readyObjectiveText) {
      logger.warn({
        hasClarifiedDemand: Boolean(readyClarifiedDemand),
        hasSummary: Boolean(readyClarificationSummary),
        hasObjective: Boolean(readyObjectiveText),
        hasOperationalObjective: Boolean(result.operational_objective)
      }, "Clarifier 返回 READY 但 payload 不完整，降级为 NEEDS_CLARIFICATION");
      return {
        status: "NEEDS_CLARIFICATION",
        display_title: result.display_title?.trim(),
        clarification_question: "I have enough context to plan, but the response was malformed. Could you confirm the objective in one sentence, plus any constraints I should respect?"
      };
    }

    // 提取并清洗 workspace_override：只接受绝对路径（POSIX 风格 /xxx）
    const rawOverride = typeof result.workspace_override === "string"
      ? result.workspace_override.trim().replace(/\/+$/, "")
      : "";
    const workspaceOverride = rawOverride.length > 0 && rawOverride.startsWith("/")
      ? rawOverride
      : null;

    return {
      status: "READY",
      display_title: result.display_title?.trim(),
      clarified_demand: readyClarifiedDemand,
      operational_objective: {
        objective: readyObjectiveText,
        acceptance_criteria: normalizeStringArray(result.operational_objective.acceptance_criteria),
        constraints: normalizeStringArray(result.operational_objective.constraints),
        non_goals: normalizeStringArray(result.operational_objective.non_goals),
        termination_conditions: normalizeStringArray(result.operational_objective.termination_conditions)
      },
      clarification_summary: readyClarificationSummary,
      workspace_override: workspaceOverride
    };
  }

  /**
   * 函数作用：根据需求当前状态生成下一批可执行子目标计划。
   *
   * 参数说明：
   * - demand：当前需求。
   * - settings：模型调用设置。
   * - existingSubgoals：已经存在的子目标列表。
   * - executions：与需求相关的执行记录。
   * - memories：可参考的历史记忆。
   * - reason：规划触发原因。
   *
   * 返回值：
   * - Promise<FrontierPlanResult>：包含计划项和需求元数据补丁的结果。
   */
  async generateFrontierPlan(
    demand: Demand,
    reason: EventReason,
    planningRound: number,
    settings: Settings,
    runtimeContext?: ReplanRuntimeContext
  ): Promise<{
    subgoals: SubgoalContract[];
    payload: PlanGeneratedPayload;
    llm_error?: {
      message: string;
      error_name: string;
    };
  }> {
    const compactContext = compactRuntimeContext(runtimeContext);
    let result: FrontierPlanResult;
    let capturedLlmError: { message: string; error_name: string } | undefined;
    try {
      result = await this.llmClient.generateJson<FrontierPlanResult>({
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
          "Use the runtime session and recent event history as the current source of truth for where the work is, what failed, what is waiting, and what should not be repeated.",
          "If re-planning after a failed, partial, blocked, or unverifiable result, address the concrete gap or blocker instead of restarting the same path.",
          "Respect accepted progress and existing artifacts mentioned in recent events or memory.",
          "Do not mutate the demand objective.",
          "",
          "## Subgoal kinds — IMPORTANT",
          'Every frontier subgoal has a "kind" field:',
          '  - "build" (default): execute the work, produce artifacts (files, code, structured outputs).',
          '  - "recon": read-only investigation. The worker MUST NOT write or modify anything.',
          "    It MAY use any read-only tool: file inspection (Read / Glob / Grep / ls / cat / git status),",
          "    Web / documentation lookup (WebFetch / WebSearch / curl GET), read-only third-party API queries,",
          "    and delegated sub-investigation (Task).",
          "",
          "When to emit recon subgoals:",
          "- The demand mentions an existing target you have NOT inspected yet and cannot confidently plan around",
          "  without knowing its structure / dependencies / state (a local repo, a remote API, a published spec, etc.).",
          "- Acceptance criteria reference an EXTERNAL fact whose current value you should look up.",
          "- The user asks to modify/refactor a specific file or module whose exact location is unclear.",
          "",
          "When NOT to emit recon:",
          "- The demand is to create something from scratch in a new directory with no external dependencies.",
          "- You already have enough information from prior recon results (visible in runtime context).",
          "- The task is trivial / well-understood.",
          "",
          "Do NOT mix recon and build subgoals in the same frontier. Either all 'recon' (future round becomes 'build')",
          "OR all 'build' (enough info already).",
          "",
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
                deliverables: ["file_bundle"],
                kind: "build | recon"
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
          `Reason: ${reason}`,
          `Runtime session and event context: ${JSON.stringify(compactContext)}`
        ].join("\n")
      });
    } catch (error) {
      if (!(error instanceof LlmInvocationError)) {
        throw error;
      }
      logger.warn({ err: error, demandId: demand.demand_id }, "Planner frontier JSON failed; using conservative single-step plan");
      result = this.createFallbackFrontierPlan(demand);
      // 捕获 LLM 错误信息，回传给 handler 让其 stamp brain_error；fallback plan 仍照常下发。
      capturedLlmError = {
        message: error.message ?? String(error),
        error_name: error.name ?? "LlmInvocationError"
      };
    }

    const timestamp = nowIso();

    // 把 LLM 返回的 frontier_subgoals 规整成 SubgoalContract[]。
    // 防御：弱模型（如 deepseek-v4-flash）可能漏 title/objective 或返回非数组 —— 缺 title 的项直接丢弃，
    // 缺 objective 的回落到 title，避免 undefined.trim() 抛错或建出无意义 subgoal。
    const buildSubgoals = (raw: FrontierPlanResult["frontier_subgoals"]): SubgoalContract[] => {
      const list = Array.isArray(raw) ? raw : [];
      return list
        .slice(0, 3)
        .map((item, index) => {
          const title = typeof item?.title === "string" ? item.title.trim() : "";
          if (!title) {
            return null; // 无标题的 subgoal 无法执行，丢弃。
          }
          const objective = typeof item?.objective === "string" && item.objective.trim()
            ? item.objective.trim()
            : title;
          const kind: "build" | "recon" = item.kind === "recon" ? "recon" : "build";
          const deliverables = kind === "recon"
            ? (normalizeDeliverables(item.deliverables).includes("structured_output_json")
                ? normalizeDeliverables(item.deliverables)
                : ["structured_output_json" as const])
            : normalizeDeliverables(item.deliverables);
          return {
            subgoal_id: createId("subgoal"),
            demand_id: demand.demand_id,
            title,
            objective,
            success_criteria: normalizeStringArray(item.success_criteria),
            failure_criteria: normalizeStringArray(item.failure_criteria),
            constraints: normalizeStringArray(item.constraints),
            budget: {
              max_steps: kind === "recon" ? 12 : 20,
              max_minutes: kind === "recon" ? 5 : 15
            },
            deliverables,
            dependencies: [],
            priority: index + 1,
            state: SubgoalState.PLANNED,
            planning_round: planningRound,
            kind,
            created_at: timestamp,
            updated_at: timestamp
          } as SubgoalContract;
        })
        .filter((sg): sg is SubgoalContract => sg !== null);
    };

    let subgoals = buildSubgoals(result.frontier_subgoals);

    // 空 frontier 不是硬错误：弱模型在长上下文下偶发返回空 frontier_subgoals（即使整体 plan 合法）。
    // 旧实现 throw "no frontier subgoals" → handler 标红 → ops 每轮自愈重试 → 又空 → 死循环。
    // 改为回落到保守 fallback plan（至少 1 个可执行 subgoal），让任务能继续推进；同时记一条 brain_error
    // 提示模型质量问题（capturedLlmError），但不阻断。
    if (subgoals.length === 0) {
      logger.warn({ demandId: demand.demand_id, planningRound }, "Planner 返回空 frontier_subgoals，回落到保守 fallback plan");
      result = this.createFallbackFrontierPlan(demand);
      subgoals = buildSubgoals(result.frontier_subgoals);
      capturedLlmError = capturedLlmError ?? {
        message: "Planner returned no frontier subgoals; used conservative fallback plan",
        error_name: "EmptyFrontierFallback"
      };
    }

    // fallback 自身恒非空；真要再为空说明代码契约被破坏，此时才是真异常。
    if (subgoals.length === 0) {
      throw new Error("Planner returned no frontier subgoals (fallback also empty)");
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
          planner_reason: reason,
          session_id: compactContext?.session?.session_id ?? null,
          previous_frontier_subgoal_ids: compactContext?.session?.frontier_subgoal_ids ?? [],
          recent_event_types: compactContext?.recent_events?.map((event) => event.event_type) ?? []
        },
        frontier_subgoal_ids: subgoals.map((item) => item.subgoal_id),
        overall_plan_outline: overallPlanOutline,
        high_level_summary: {
          mission_state_summary: result.mission_state_summary,
          episodic_trace_summary: result.episodic_trace_summary,
          lessons_or_policy_summary: result.lessons_or_policy_summary
        },
        reason
      },
      llm_error: capturedLlmError
    };
  }

  private createFallbackFrontierPlan(demand: Demand): FrontierPlanResult {
    const objective = demand.operational_objective?.objective
      ?? demand.clarified_demand
      ?? demand.initial_input;
    const acceptanceCriteria = demand.operational_objective?.acceptance_criteria?.length
      ? demand.operational_objective.acceptance_criteria
      : ["Produce a concrete result that directly addresses the clarified demand"];
    const constraints = demand.operational_objective?.constraints?.length
      ? demand.operational_objective.constraints
      : ["Keep changes scoped to the requested workspace and report blockers clearly"];

    return {
      overall_plan_outline: [
        {
          title: demand.title || "Execute Demand",
          objective,
          execution_mode: "sequential",
          rationale: "Fallback plan created because the planner model did not return valid JSON.",
          frontier_subgoal_indexes: [0]
        }
      ],
      frontier_subgoals: [
        {
          title: demand.title || "Execute Demand",
          objective,
          success_criteria: acceptanceCriteria,
          failure_criteria: ["Execution is blocked by missing context, permissions, runtime errors, or unavailable dependencies"],
          constraints,
          deliverables: ["file_bundle"]
        }
      ],
      mission_state_summary: "Planner fallback is active; proceed with one conservative executable subgoal.",
      episodic_trace_summary: "The planner model response could not be parsed as JSON.",
      lessons_or_policy_summary: "Keep execution scoped and ask for user input if important context is missing."
    };
  }
}
