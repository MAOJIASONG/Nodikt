/**
 * 文件名称：demandHandlers.ts
 * 文件作用：需求事件处理器模块，负责处理用户输入、澄清完成、暂停、恢复、取消和任务完成事件。
 *
 * 主要职责：
 * 1. 将用户输入转换为新需求或既有需求的会话更新。
 * 2. 推进需求澄清、规划和完成状态。
 * 3. 处理需求级控制动作，包括暂停、恢复和取消。
 * 4. 发布后续规划、执行停止或完成事件。
 *
 * 依赖模块：
 * - domain：需求、事件和状态类型。
 * - event_bus/types：处理器上下文。
 * - stateMachine 与 sessionState：状态流转和会话元数据维护。
 * - executionRuntime：活跃执行查询。
 *
 * 注意事项：
 * - 需求控制动作可能影响多个执行和子目标，必须保持事件链完整。
 * - 用户输入处理应兼容新需求和澄清回复两种场景。
 */
import {
  createEvent,
  createId,
  DecisionAction,
  DecisionReasonCode,
  DemandPhase,
  DemandState,
  EventType,
  HandlerResult,
  SchedulerEvent,
  SubgoalContract,
  SubgoalState,
  nowIso
} from "../../../../domain/index.js";
import type { ReconSubgoalDraft } from "../../../engines/planner/service.js";
import { HandlerContext } from "../../event_bus/types.js";
import { createLogger } from "../../../../logger.js";
import {
  appendConversationTurns,
  appendExecutionGuidance,
  readConversationHistory
} from "../sessionState.js";
import {
  isTerminalDemand,
  transitionDemand
} from "../stateMachine.js";
import type { DemandSnapshotPatch } from "../stateMachine.js";
import { listActiveExecutionsForDemand } from "../executionRuntime.js";

const logger = createLogger("handlers:demand");

/**
 * Clarifier 阶段允许的 recon 派发上限（per demand）。超过后强制降级为 NEEDS_CLARIFICATION，
 * 避免 NEEDS_RECON ↔ recon ↔ findings ↔ clarifier 死循环。
 */
const MAX_CLARIFY_RECON_ROUNDS = 3;

function readReconRoundsUsed(metadata: Record<string, unknown> | undefined): number {
  if (!metadata) return 0;
  const raw = metadata.recon_rounds_used;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
}

/**
 * 判断回灌的 recon findings 文本是否表明所有 recon 都失败了。
 * Recon barrier 在每条 finding 的 worker summary 行前缀写 "[recon FAILED: <status>]"。
 * 如果所有 finding 都以这个前缀开头，说明本轮 recon 实际没拿到任何有效信息 ——
 * 通常是 LLM gateway 503 / claude code 沙箱拦截 / spawn ENOENT 这类工具级故障，
 * 跟用户的需求描述没关系。
 */
function isAllReconFailed(reconFindingsText: string): boolean {
  if (!reconFindingsText) return false;
  const blocks = reconFindingsText.split(/\n---\n/);
  if (blocks.length === 0) return false;
  return blocks.every((block) => /Worker summary:\s*\[recon FAILED:/.test(block));
}

/**
 * 从全部失败的 recon findings 里抽取 3 条以内的失败原因摘要，附在 fallback question 里
 * 让用户知道这不是她说不清，是工具挂了。
 */
function summarizeReconFailures(reconFindingsText: string): string {
  if (!reconFindingsText) return "";
  const reasons = [...reconFindingsText.matchAll(/Worker summary:\s*\[recon FAILED:[^\]]+\]\s*([^\n]+)/g)]
    .map((m) => (m[1] ?? "").trim())
    .filter((reason) => reason.length > 0)
    .slice(0, 3);
  return reasons.length > 0 ? reasons.join("\n  • ") : "";
}

/**
 * 函数作用：把 clarifier 给出的 recon_subgoals 草稿物化为可调度的 SubgoalContract 列表。
 * clarification 阶段还没有正式 planning_round，临时给 1。
 */
function materializeReconSubgoals(
  demandId: string,
  drafts: ReconSubgoalDraft[],
  timestamp: string
): SubgoalContract[] {
  return drafts.map((draft, index) => ({
    subgoal_id: createId("subgoal"),
    demand_id: demandId,
    title: draft.title.trim(),
    objective: draft.objective.trim(),
    success_criteria: draft.success_criteria,
    failure_criteria: draft.failure_criteria ?? [],
    constraints: draft.constraints ?? [],
    budget: { max_steps: 12, max_minutes: 5 },
    deliverables: ["structured_output_json"],
    dependencies: [],
    priority: index + 1,
    state: SubgoalState.PLANNED,
    planning_round: 1,
    kind: "recon",
    created_at: timestamp,
    updated_at: timestamp
  }));
}

/**
 * 函数作用：判断 child 路径是不是位于 parent 之内（或就是 parent 本身）。
 *
 * 注意事项：
 * - 仅做字符串前缀匹配，不解析符号链接。
 * - parent 必须传绝对路径，否则结果不可靠。
 */
function pathIsWithin(child: string, parent: string): boolean {
  if (!child || !parent) return false;
  const c = child.replace(/\/+$/, "");
  const p = parent.replace(/\/+$/, "");
  if (c === p) return true;
  return c.startsWith(p + "/");
}

/**
 * 函数作用：判断给定的输出路径是否已被授权（在 settings.workspace_root / settings.workspace_grants /
 * demand.metadata.workspace_grants 任一覆盖范围内）。
 */
function isPathAuthorized(
  path: string,
  settings: { workspace_root: string; workspace_grants?: Array<{ path: string }> },
  demand: { metadata?: Record<string, unknown> }
): boolean {
  if (pathIsWithin(path, settings.workspace_root)) return true;
  for (const grant of settings.workspace_grants ?? []) {
    if (grant && typeof grant.path === "string" && pathIsWithin(path, grant.path)) return true;
  }
  const demandGrants = demand.metadata?.workspace_grants;
  if (Array.isArray(demandGrants)) {
    for (const grant of demandGrants) {
      if (grant && typeof (grant as { path?: unknown }).path === "string"
          && pathIsWithin(path, (grant as { path: string }).path)) {
        return true;
      }
    }
  }
  return false;
}

function describeReconForUser(drafts: ReconSubgoalDraft[], rationale?: string): string {
  const lines = [
    rationale ? rationale : "Let me look around the target first so I plan accurately."
  ];
  drafts.forEach((draft, i) => {
    lines.push(`  ${i + 1}. ${draft.title} — ${draft.objective}`);
  });
  lines.push("(Read-only inspection — I won't modify anything. I'll come back with what I found.)");
  return lines.join("\n");
}

/**
 * 函数作用：处理用户输入事件，创建新需求或更新既有需求会话。
 *
 * 参数说明：
 * - event：用户输入事件。
 * - ctx：事件处理器上下文。
 *
 * 返回值：
 * - Promise<HandlerResult>：需求创建、澄清或对话更新后的处理结果。
 */
export async function onUserInput(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const payload = event.payload as { input_text: string; input_kind: string };
  logger.info({ eventId: event.event_id, inputKind: payload.input_kind, demandId: event.demand_id }, "收到用户输入事件");
  if (payload.input_kind === "initial_demand") {
    const timestamp = nowIso();
    const demandId = event.demand_id ?? createId("demand");
    const settings = await ctx.repositories.loadSettings();
    logger.info({ demandId }, "开始澄清初始需求");
    const clarification = await ctx.planner.clarifyDemand({
      rawInput: payload.input_text,
      settings
    });
    // 三档分流：NEEDS_CLARIFICATION（问用户）/ NEEDS_RECON（派 read-only worker 探）/ READY（进 planner）
    const baseDemand = {
      demand_id: demandId,
      title: clarification.display_title?.slice(0, 60) || payload.input_text.slice(0, 80),
      type: "project" as const,
      initial_input: payload.input_text,
      clarified_demand: null,
      operational_objective: null,
      state: DemandState.PENDING_ALIGNMENT,
      autonomy_level: settings.default_autonomy_level,
      acceptance_criteria: [],
      constraints: [],
      progress_percent: 0,
      current_phase: DemandPhase.ALIGNMENT,
      active_decision_id: null,
      tags: [],
      created_at: timestamp,
      updated_at: timestamp
    };

    if (clarification.status === "NEEDS_RECON") {
      const reconDescription = describeReconForUser(clarification.recon_subgoals!, clarification.recon_rationale);
      await ctx.repositories.demands.upsert({
        ...baseDemand,
        metadata: {
          runtime_session: {
            phase: DemandPhase.ALIGNMENT,
            waiting_on: "recon_worker",
            frontier_subgoal_ids: [],
            latest_checkpoint: event.event_id,
            progress_note: "Recon dispatched to inform clarification",
            last_progress_at: timestamp
          },
          recon_in_progress: true,
          recon_rounds_used: 1,
          conversation_history: [
            { role: "user", content: payload.input_text, created_at: timestamp },
            { role: "assistant", content: reconDescription, created_at: timestamp }
          ]
        }
      });
      const reconSubgoals = materializeReconSubgoals(demandId, clarification.recon_subgoals!, timestamp);
      logger.info({
        demandId,
        reconSubgoalCount: reconSubgoals.length,
        titles: reconSubgoals.map((sg) => sg.title)
      }, "初始需求选择派 recon worker 调研，不打扰用户");
      return {
        events: reconSubgoals.map((sg) => createEvent(
          EventType.SUBGOAL_CREATED,
          { subgoal_contract: sg, planning_round: 1, source: "planner" as const },
          { demand_id: demandId, subgoal_id: sg.subgoal_id }
        ))
      };
    }

    if (clarification.status === "NEEDS_CLARIFICATION") {
      await ctx.repositories.demands.upsert({
        ...baseDemand,
        metadata: {
          runtime_session: {
            phase: DemandPhase.ALIGNMENT,
            waiting_on: "user_clarification",
            frontier_subgoal_ids: [],
            latest_checkpoint: event.event_id,
            progress_note: "Initial demand needs clarification",
            last_progress_at: timestamp
          },
          clarification_question: clarification.clarification_question,
          conversation_history: [
            { role: "user", content: payload.input_text, created_at: timestamp },
            {
              role: "assistant",
              content: clarification.clarification_question ?? "Please provide the missing project/workspace path and key constraints.",
              created_at: timestamp
            }
          ]
        }
      });
      logger.info({ demandId }, "初始需求仍需要用户补充澄清");
      return {};
    }

    // READY —— 若 clarifier 提取到 workspace_override 且该路径未授权，先弹 PATH_GRANT_REQUIRED 决策
    const override = clarification.workspace_override ?? null;
    const baseConversation = [
      { role: "user" as const, content: payload.input_text, created_at: timestamp },
      {
        role: "assistant" as const,
        content: clarification.clarification_summary ?? "Clarification is complete. Moving to planning.",
        created_at: timestamp
      }
    ];

    // baseDemand 上没有 metadata 字段（initial_demand 阶段从 0 开始），所以传 undefined。
    // demand-level grants 此时必然为空，授权判定只看 settings.workspace_root 与 settings.workspace_grants。
    const needsPathGrant = override
      && !isPathAuthorized(override, settings, { metadata: undefined });

    if (needsPathGrant) {
      // 暂存 clarification 完整 payload，等用户授权后再 publish DEMAND_CLARIFICATION_COMPLETED
      const pendingPayload = {
        clarified_demand: clarification.clarified_demand!,
        operational_objective: clarification.operational_objective!,
        clarification_summary: clarification.clarification_summary!
      };
      const prompt = [
        `Nodikt 想要把产物写到这个目录：`,
        ``,
        `    ${override}`,
        ``,
        `这个路径不在当前已授权的工作目录内（系统默认目录是 ${settings.workspace_root}）。`,
        `请选择：`,
        `  • Approve Once：仅在本 demand 内授权这个目录`,
        `  • Approve & Remember：永久授权（写入 Settings.workspace_grants，所有 demand 都能用）`,
        `  • Reject / Cancel Demand：拒绝授权（你可以在对话里换个目录或重新提需求）`
      ].join("\n");
      const decision = ctx.decisionService.createRequest({
        demandId,
        source: "scheduler" as any,
        reasonCode: DecisionReasonCode.PATH_GRANT_REQUIRED,
        prompt,
        options: [
          DecisionAction.APPROVE,
          DecisionAction.REJECT,
          DecisionAction.CANCEL_DEMAND
        ],
        metadata: {
          path_grant: {
            requested_path: override,
            current_workspace_root: settings.workspace_root
          }
        }
      });
      await ctx.repositories.demands.upsert({
        ...baseDemand,
        metadata: {
          runtime_session: {
            phase: DemandPhase.ALIGNMENT,
            waiting_on: "user_decision",
            frontier_subgoal_ids: [],
            latest_checkpoint: event.event_id,
            progress_note: `Path grant required for ${override}`,
            last_progress_at: timestamp
          },
          conversation_history: baseConversation,
          pending_clarification_payload: pendingPayload,
          pending_workspace_grant_path: override
        }
      });
      logger.info({ demandId, override, decisionId: decision.decision_id }, "初始需求 READY 但目标路径未授权，已弹 PATH_GRANT_REQUIRED 决策");
      return {
        events: [
          createEvent(EventType.DECISION_REQUEST_CREATED, { decision_request: decision }, {
            demand_id: demandId,
            decision_id: decision.decision_id
          })
        ]
      };
    }

    // 路径已授权（或没指定路径）—— 直接落 DEMAND_CLARIFICATION_COMPLETED
    await ctx.repositories.demands.upsert({
      ...baseDemand,
      metadata: {
        runtime_session: {
          phase: DemandPhase.ALIGNMENT,
          waiting_on: null,
          frontier_subgoal_ids: [],
          latest_checkpoint: event.event_id,
          progress_note: "Initial demand clarified",
          last_progress_at: timestamp
        },
        conversation_history: baseConversation
      }
    });

    logger.info({ demandId }, "初始需求澄清已完成");
    return {
      events: [
        createEvent(
          EventType.DEMAND_CLARIFICATION_COMPLETED,
          {
            clarified_demand: clarification.clarified_demand!,
            operational_objective: clarification.operational_objective!,
            acceptance_criteria: clarification.operational_objective!.acceptance_criteria,
            constraints: clarification.operational_objective!.constraints,
            clarification_summary: clarification.clarification_summary!
          },
          { demand_id: demandId }
        )
      ]
    };
  }

  // clarification_reply：用户的回复继续 clarification
  // recon_findings：reviewHandlers 把 recon worker 的发现作为新一轮 clarification 输入回灌（source=scheduler）
  if (
    (payload.input_kind === "clarification_reply" || payload.input_kind === "recon_findings")
    && event.demand_id
  ) {
    const demand = await ctx.repositories.demands.getById(event.demand_id);
    if (!demand) {
      logger.warn({ demandId: event.demand_id, inputKind: payload.input_kind }, "忽略澄清/findings 回复，因为未找到对应需求");
      return {};
    }
    const isReconFindings = payload.input_kind === "recon_findings";
    const settings = await ctx.repositories.loadSettings();
    const timestamp = nowIso();
    // 检测 recon findings 是否全部失败 —— 后面的 round 计数和 fallback 模板都要参考。
    const reconAllFailed = isReconFindings && isAllReconFailed(payload.input_text);
    const reconFailureSummary = reconAllFailed ? summarizeReconFailures(payload.input_text) : "";
    logger.info({ demandId: demand.demand_id, inputKind: payload.input_kind, reconAllFailed }, "正在使用回复内容继续澄清需求");
    let clarification: Awaited<ReturnType<typeof ctx.planner.clarifyDemand>>;
    try {
      clarification = await ctx.planner.clarifyDemand({
        rawInput: [
          `Original demand: ${demand.initial_input}`,
          `Clarification conversation so far: ${JSON.stringify(readConversationHistory(demand.metadata))}`,
          demand.metadata?.clarification_question
            ? `Previous clarification question: ${String(demand.metadata.clarification_question)}`
            : "",
          isReconFindings
            ? `Recon findings from worker (system-generated, NOT a user message):\n${payload.input_text}`
            : `User clarification reply: ${payload.input_text}`,
          reconAllFailed
            ? "IMPORTANT: ALL recon subgoals above failed at the WORKER LEVEL (gateway 503, sandbox blocked, spawn error, etc) — there is NO real recon data this round. The user's request was fine; the inspection tool itself broke. Prefer NEEDS_CLARIFICATION (ask the user 1 short concrete question) over NEEDS_RECON (which would just try the broken tool again). Only choose NEEDS_RECON if you can describe a meaningfully different inspection that might succeed."
            : ""
        ].filter(Boolean).join("\n"),
        settings
      });
    } catch (clarifierError) {
      // Critical: if clarifier throws (LLM returned malformed READY payload, TypeError on missing field,
      // etc), the whole recon→clarifier loop deadlocks. Degrade gracefully — ask the user.
      const detail = clarifierError instanceof Error ? clarifierError.message : String(clarifierError);
      logger.error({ err: clarifierError, demandId: demand.demand_id, inputKind: payload.input_kind }, "Clarifier failed; degrading to ask user");
      const fallbackQuestion = [
        isReconFindings
          ? "Recon completed but I couldn't auto-summarize the findings to continue."
          : "I couldn't process your reply automatically.",
        `(internal: ${detail.slice(0, 200)})`,
        "Could you tell me directly what you'd like me to do next? E.g.:",
        "- Specific output path / framework / language",
        "- Or 'just go ahead with X' to skip remaining ambiguity"
      ].join("\n");
      await ctx.repositories.demands.upsert(transitionDemand(demand, {
        metadata: {
          ...appendConversationTurns(demand.metadata, [
            isReconFindings
              ? { role: "assistant" as const, content: `[Recon findings]\n${payload.input_text}`, created_at: timestamp }
              : { role: "user" as const, content: payload.input_text, created_at: timestamp },
            { role: "assistant" as const, content: fallbackQuestion, created_at: timestamp }
          ]),
          clarification_question: fallbackQuestion,
          recon_in_progress: false
        }
      }, {
        phase: DemandPhase.ALIGNMENT,
        waiting_on: "user_clarification",
        progress_note: "Clarifier failed, asking user"
      }));
      return {};
    }

    // 把这一轮的输入写进对话历史。来自 recon worker 用 "assistant" 前缀标识便于前端区分
    const incomingTurn = isReconFindings
      ? {
          role: "assistant" as const,
          content: `[Recon findings]\n${payload.input_text}`,
          created_at: timestamp
        }
      : {
          role: "user" as const,
          content: payload.input_text,
          created_at: timestamp
        };

    if (clarification.status === "NEEDS_RECON") {
      // Safety net：到达 recon 轮数上限就强制降级问用户。
      // 但失败的 recon round（全部 [recon FAILED]）不消耗预算 —— 工具挂了不算用户的锅，
      // 让 clarifier 还能选 NEEDS_RECON 再试一次，或者改主意问用户。
      const usedRounds = readReconRoundsUsed(demand.metadata);
      if (usedRounds >= MAX_CLARIFY_RECON_ROUNDS && !reconAllFailed) {
        const failureNote = reconFailureSummary
          ? `\n\n上一轮 recon 全部失败（不是你说不清，是探查工具本身出错）：\n  • ${reconFailureSummary}\n`
          : "";
        const fallbackQuestion = `I've already dispatched ${usedRounds} round${usedRounds > 1 ? "s" : ""} of read-only investigation and still need more clarity. Could you tell me directly:\n\n- ${clarification.recon_rationale ?? "What I still need to know"}\n\n(${clarification.recon_subgoals?.slice(0, 2).map((sg) => sg.title).join(" / ") ?? "the remaining gap"})${failureNote}`;
        logger.warn({
          demandId: demand.demand_id,
          usedRounds,
          maxRounds: MAX_CLARIFY_RECON_ROUNDS,
          reconAllFailed
        }, "Recon 轮数达上限，强制降级为问用户");
        await ctx.repositories.demands.upsert(transitionDemand(demand, {
          title: clarification.display_title?.slice(0, 60) || demand.title,
          metadata: {
            ...appendConversationTurns(demand.metadata, [
              incomingTurn,
              { role: "assistant", content: fallbackQuestion, created_at: timestamp }
            ]),
            clarification_question: fallbackQuestion,
            recon_in_progress: false
          }
        }, {
          phase: DemandPhase.ALIGNMENT,
          waiting_on: "user_clarification",
          progress_note: `Recon budget exhausted (${usedRounds}/${MAX_CLARIFY_RECON_ROUNDS}), asking user`
        }));
        return {};
      }

      // 失败的 recon round 不消耗预算 —— 503 / sandbox 拦截这种工具级故障重试不算"用户没说清"。
      const nextRoundCount = reconAllFailed ? usedRounds : usedRounds + 1;
      const reconDescription = describeReconForUser(clarification.recon_subgoals!, clarification.recon_rationale);
      await ctx.repositories.demands.upsert(transitionDemand(demand, {
        title: clarification.display_title?.slice(0, 60) || demand.title,
        metadata: {
          ...appendConversationTurns(demand.metadata, [
            incomingTurn,
            { role: "assistant", content: reconDescription, created_at: timestamp }
          ]),
          clarification_question: null,
          recon_in_progress: true,
          recon_rounds_used: nextRoundCount
        }
      }, {
        phase: DemandPhase.ALIGNMENT,
        waiting_on: "recon_worker",
        progress_note: reconAllFailed
          ? `Recon retry (round ${nextRoundCount}/${MAX_CLARIFY_RECON_ROUNDS} — prior round failed at worker level, not counted)`
          : `Recon dispatched to inform clarification (round ${nextRoundCount}/${MAX_CLARIFY_RECON_ROUNDS})`
      }));
      const reconSubgoals = materializeReconSubgoals(demand.demand_id, clarification.recon_subgoals!, timestamp);
      logger.info({
        demandId: demand.demand_id,
        reconSubgoalCount: reconSubgoals.length,
        titles: reconSubgoals.map((sg) => sg.title),
        round: usedRounds + 1
      }, "澄清阶段决定继续派 recon worker 调研");
      return {
        events: reconSubgoals.map((sg) => createEvent(
          EventType.SUBGOAL_CREATED,
          { subgoal_contract: sg, planning_round: 1, source: "planner" as const },
          { demand_id: demand.demand_id, subgoal_id: sg.subgoal_id }
        ))
      };
    }

    if (clarification.status === "NEEDS_CLARIFICATION") {
      logger.info({ demandId: demand.demand_id }, "澄清回复仍需要更多用户输入");
      await ctx.repositories.demands.upsert(transitionDemand(demand, {
        title: clarification.display_title?.slice(0, 60) || demand.title,
        metadata: {
          ...appendConversationTurns(demand.metadata, [
            incomingTurn,
            {
              role: "assistant",
              content: clarification.clarification_question ?? "Please provide the remaining missing execution context.",
              created_at: timestamp
            }
          ]),
          clarification_question: clarification.clarification_question,
          recon_in_progress: false
        }
      }, {
        phase: DemandPhase.ALIGNMENT,
        waiting_on: "user_clarification",
        progress_note: "Clarification still needed"
      }));
      return {};
    }

    // READY —— 若 workspace_override 未授权，弹 PATH_GRANT_REQUIRED 决策
    const overrideReply = clarification.workspace_override ?? null;
    const needsPathGrantReply = overrideReply
      && !isPathAuthorized(overrideReply, settings, demand);

    if (needsPathGrantReply) {
      const pendingPayload = {
        clarified_demand: clarification.clarified_demand!,
        operational_objective: clarification.operational_objective!,
        clarification_summary: clarification.clarification_summary!
      };
      const grantPrompt = [
        `Nodikt 想要把产物写到这个目录：`,
        ``,
        `    ${overrideReply}`,
        ``,
        `这个路径不在当前已授权的工作目录内（系统默认目录是 ${settings.workspace_root}）。`,
        `请选择：`,
        `  • Approve Once：仅在本 demand 内授权这个目录`,
        `  • Approve & Remember：永久授权（写入 Settings.workspace_grants）`,
        `  • Reject / Cancel Demand：拒绝授权`
      ].join("\n");
      const decision = ctx.decisionService.createRequest({
        demandId: demand.demand_id,
        source: "scheduler" as any,
        reasonCode: DecisionReasonCode.PATH_GRANT_REQUIRED,
        prompt: grantPrompt,
        options: [DecisionAction.APPROVE, DecisionAction.REJECT, DecisionAction.CANCEL_DEMAND],
        metadata: {
          path_grant: {
            requested_path: overrideReply,
            current_workspace_root: settings.workspace_root
          }
        }
      });
      await ctx.repositories.demands.upsert(transitionDemand(demand, {
        title: clarification.display_title?.slice(0, 60) || demand.title,
        metadata: {
          ...appendConversationTurns(demand.metadata, [
            incomingTurn,
            {
              role: "assistant",
              content: clarification.clarification_summary ?? "Clarification is complete. Moving to planning.",
              created_at: timestamp
            }
          ]),
          clarification_question: null,
          recon_in_progress: false,
          pending_clarification_payload: pendingPayload,
          pending_workspace_grant_path: overrideReply
        }
      }, {
        phase: DemandPhase.ALIGNMENT,
        waiting_on: "user_decision",
        progress_note: `Path grant required for ${overrideReply}`
      }));
      logger.info({ demandId: demand.demand_id, override: overrideReply, decisionId: decision.decision_id }, "澄清完成但路径未授权，已弹 PATH_GRANT_REQUIRED 决策");
      return {
        events: [
          createEvent(EventType.DECISION_REQUEST_CREATED, { decision_request: decision }, {
            demand_id: demand.demand_id,
            decision_id: decision.decision_id
          })
        ]
      };
    }

    logger.info({ demandId: demand.demand_id }, "澄清回复已接受");
    await ctx.repositories.demands.upsert(transitionDemand(demand, {
      title: clarification.display_title?.slice(0, 60) || demand.title,
      metadata: {
        ...appendConversationTurns(demand.metadata, [
          incomingTurn,
          {
            role: "assistant",
            content: clarification.clarification_summary ?? "Clarification is complete. Moving to planning.",
            created_at: timestamp
          }
        ]),
        clarification_question: null,
        recon_in_progress: false
      }
    }, {
      phase: DemandPhase.ALIGNMENT,
      waiting_on: null,
      progress_note: "Clarification reply accepted"
    }));

    return {
      events: [
        createEvent(
          EventType.DEMAND_CLARIFICATION_COMPLETED,
          {
            clarified_demand: clarification.clarified_demand!,
            operational_objective: clarification.operational_objective!,
            acceptance_criteria: clarification.operational_objective!.acceptance_criteria,
            constraints: clarification.operational_objective!.constraints,
            clarification_summary: clarification.clarification_summary!
          },
          { demand_id: demand.demand_id }
        )
      ]
    };
  }

  logger.debug({ eventId: event.event_id, inputKind: payload.input_kind }, "忽略不支持的用户输入类型");
  return {};
}

/**
 * 函数作用：处理需求澄清完成事件并触发初始规划。
 *
 * 参数说明：
 * - event：需求澄清完成事件。
 * - ctx：事件处理器上下文。
 *
 * 返回值：
 * - Promise<HandlerResult>：需求状态更新和后续规划事件发布结果。
 */
export async function onClarificationCompleted(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (!demand) {
    logger.warn({ demandId: event.demand_id }, "忽略澄清完成事件，因为未找到对应需求");
    return {};
  }
  const payload = event.payload as {
    clarified_demand: string;
    operational_objective: NonNullable<typeof demand.operational_objective>;
    acceptance_criteria: string[];
    constraints: string[];
  };

  await ctx.repositories.demands.upsert(transitionDemand(demand, {
    clarified_demand: payload.clarified_demand,
    operational_objective: payload.operational_objective,
    acceptance_criteria: payload.acceptance_criteria,
    constraints: payload.constraints,
    state: DemandState.READY,
    current_phase: DemandPhase.PLANNING,
    metadata: {
      ...(demand.metadata ?? {}),
      clarification_question: null
    }
  }, {
    phase: DemandPhase.PLANNING,
    waiting_on: null,
    progress_note: "Clarification completed"
  }));

  logger.info({ demandId: demand.demand_id }, "需求澄清已完成，准备请求初始规划");
  return {
    events: [createEvent(EventType.REPLAN_REQUESTED, { reason: "initial_plan" }, { demand_id: demand.demand_id })]
  };
}

/**
 * 函数作用：处理需求暂停事件。
 *
 * 参数说明：
 * - event：需求暂停事件。
 * - ctx：事件处理器上下文。
 *
 * 返回值：
 * - Promise<HandlerResult>：暂停后的需求状态处理结果。
 */
export async function onDemandPaused(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (!demand) {
    logger.warn({ demandId: event.demand_id }, "忽略暂停请求，因为未找到对应需求");
    return {};
  }
  if (isTerminalDemand(demand)) {
    logger.debug({ demandId: demand.demand_id, state: demand.state }, "忽略终态需求的暂停请求");
    return {};
  }
  await ctx.repositories.demands.upsert(transitionDemand(demand, {
    state: DemandState.PAUSED
  }, {
    waiting_on: "resume",
    progress_note: "Demand paused"
  }));

  const activeExecutions = await listActiveExecutionsForDemand(demand.demand_id, ctx);
  logger.info({ demandId: demand.demand_id, activeExecutionCount: activeExecutions.length }, "需求已暂停");
  return {
    events: activeExecutions.map((execution) => createEvent(
      EventType.EXECUTION_STOP_REQUESTED,
      { reason: "demand_paused" },
      {
        demand_id: demand.demand_id,
        subgoal_id: execution.subgoal_id,
        execution_id: execution.execution_id,
        worker_id: execution.worker_id
      }
    ))
  };
}

/**
 * 函数作用：处理需求恢复事件。
 *
 * 参数说明：
 * - event：需求恢复事件。
 * - ctx：事件处理器上下文。
 *
 * 返回值：
 * - Promise<HandlerResult>：恢复后的需求状态处理结果。
 */
export async function onDemandResumed(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (!demand) {
    logger.warn({ demandId: event.demand_id }, "忽略恢复请求，因为未找到对应需求");
    return {};
  }
  if (isTerminalDemand(demand)) {
    logger.debug({ demandId: demand.demand_id, state: demand.state }, "忽略终态需求的恢复请求");
    return {};
  }
  const resumeNote = typeof (event.payload as { note?: unknown })?.note === "string"
    ? (event.payload as { note?: string }).note!.trim()
    : "";
  const timestamp = nowIso();
  const demandPatch: DemandSnapshotPatch = {
    state: DemandState.READY,
    current_phase: DemandPhase.PLANNING
  };
  if (resumeNote.length > 0) {
    demandPatch.metadata = appendExecutionGuidance(demand.metadata, {
      source: "user",
      kind: "resume_instruction",
      note: resumeNote,
      created_at: timestamp
    });
  }
  await ctx.repositories.demands.upsert(transitionDemand(demand, demandPatch, {
    phase: DemandPhase.PLANNING,
    waiting_on: null,
    progress_note: resumeNote.length > 0 ? "Demand resumed with instruction" : "Demand resumed"
  }));
  logger.info({ demandId: demand.demand_id }, "需求已恢复，准备请求重新规划");
  return {
    events: [createEvent(
      EventType.REPLAN_REQUESTED,
      { reason: "resume", note: resumeNote.length > 0 ? resumeNote : null },
      { demand_id: demand.demand_id }
    )]
  };
}

/**
 * 函数作用：处理需求取消事件并停止关联活跃执行。
 *
 * 参数说明：
 * - event：需求取消事件。
 * - ctx：事件处理器上下文。
 *
 * 返回值：
 * - Promise<HandlerResult>：取消后的需求、子目标和执行处理结果。
 */
export async function onDemandCancelled(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (!demand) {
    logger.warn({ demandId: event.demand_id }, "忽略取消请求，因为未找到对应需求");
    return {};
  }
  if (isTerminalDemand(demand)) {
    logger.debug({ demandId: demand.demand_id, state: demand.state }, "忽略终态需求的取消请求");
    return {};
  }
  await ctx.repositories.demands.upsert(transitionDemand(demand, {
    state: DemandState.CANCELLED,
    current_phase: DemandPhase.CANCELLED
  }, {
    phase: DemandPhase.CANCELLED,
    waiting_on: null,
    progress_note: "Demand cancelled"
  }));

  const activeExecutions = await listActiveExecutionsForDemand(demand.demand_id, ctx);
  logger.info({ demandId: demand.demand_id, activeExecutionCount: activeExecutions.length }, "需求已取消");
  return {
    events: activeExecutions.map((execution) => createEvent(
      EventType.EXECUTION_STOP_REQUESTED,
      { reason: "demand_cancelled" },
      {
        demand_id: demand.demand_id,
        subgoal_id: execution.subgoal_id,
        execution_id: execution.execution_id,
        worker_id: execution.worker_id
      }
    ))
  };
}

/**
 * 函数作用：处理任务完成事件并将需求推进到完成状态。
 *
 * 参数说明：
 * - event：任务完成事件。
 * - ctx：事件处理器上下文。
 *
 * 返回值：
 * - Promise<HandlerResult>：需求完成状态更新结果。
 */
export async function onMissionCompleted(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (!demand) {
    logger.warn({ demandId: event.demand_id }, "忽略任务完成事件，因为未找到对应需求");
    return {};
  }
  await ctx.repositories.demands.upsert(transitionDemand(demand, {
    state: DemandState.COMPLETED,
    current_phase: DemandPhase.COMPLETED,
    progress_percent: 100
  }, {
    phase: DemandPhase.COMPLETED,
    waiting_on: null,
    progress_note: "Mission completed"
  }));
  logger.info({ demandId: demand.demand_id }, "任务已完成");
  return {};
}
