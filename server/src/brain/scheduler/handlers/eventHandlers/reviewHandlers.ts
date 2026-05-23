/**
 * 文件名称：reviewHandlers.ts
 * 文件作用：审查事件处理器模块，负责处理验证完成、决策请求和决策响应事件。
 *
 * 主要职责：
 * 1. 根据验证结果调用归并服务判断后续动作。
 * 2. 推进执行、子目标和需求状态。
 * 3. 在需要时创建决策请求或发布重规划事件。
 * 4. 处理用户或模型决策响应并继续调度流程。
 *
 * 依赖模块：
 * - domain：验证、决策、执行和事件类型。
 * - event_bus/types：处理器上下文。
 * - stateMachine：状态转换。
 * - planProgress：子目标解锁。
 * - shared：事件引用收集工具。
 *
 * 注意事项：
 * - 审查处理器连接执行结果与下一步调度，状态写入顺序需要保持一致。
 * - 决策响应动作新增时，应同步归并服务和本处理器分支。
 */
import {
  createEvent,
  DecisionAction,
  DecisionReasonCode,
  DecisionRequest,
  DecisionStatus,
  Demand,
  DemandPhase,
  DemandState,
  EventReason,
  EventType,
  ExecutionState,
  HandlerResult,
  SchedulerEvent,
  SubgoalState,
  nowIso
} from "../../../../domain/index.js";
import { HandlerContext } from "../../event_bus/types.js";
import { createLogger } from "../../../../logger.js";
import {
  DEMAND_TRANSITIONS,
  EXECUTION_TRANSITIONS,
  SUBGOAL_TRANSITIONS,
  assertTransition,
  isTerminalDemand,
  transitionDemand,
  transitionSubgoal,
  tryTransition
} from "../stateMachine.js";
import {
  appendExecutionGuidance,
  appendRetryHistory,
  classifyDecisionReplyIntent,
  patchRuntimeSession,
  readRetryHistory
} from "../sessionState.js";
import { collectUnlockedPlannedSubgoals } from "../planProgress.js";
import {
  demandHasActiveExecutions,
  extractWorkerError,
  syncWorkerExecutionSlots
} from "../executionRuntime.js";
import { collectEventRefs } from "./shared.js";
import { collectWorkspaceGrants } from "../../../dispatch/dispatcher/service.js";

const logger = createLogger("handlers:review");

const RECON_ACTIVE_EXECUTION_STATES = new Set<ExecutionState>([
  ExecutionState.QUEUED,
  ExecutionState.RUNNING,
  ExecutionState.WAITING_RESULT,
  ExecutionState.VERIFYING
]);

/**
 * 函数作用：查找同一 demand 下、除当前外仍处于 active 状态的 recon execution。
 * 用于实现并行 recon barrier —— 只有所有 recon 都完成才回灌发现一次。
 */
async function listActiveOtherReconExecutions(
  ctx: HandlerContext,
  demandId: string,
  excludeExecutionId: string
) {
  const [executions, subgoals] = await Promise.all([
    ctx.repositories.executions.list(),
    ctx.repositories.subgoals.list()
  ]);
  const reconSubgoalIds = new Set(
    subgoals.filter((sg) => sg.demand_id === demandId && sg.kind === "recon").map((sg) => sg.subgoal_id)
  );
  return executions.filter((exec) => (
    exec.demand_id === demandId
    && exec.execution_id !== excludeExecutionId
    && reconSubgoalIds.has(exec.subgoal_id)
    && RECON_ACTIVE_EXECUTION_STATES.has(exec.state)
  ));
}
const reconcilingVerificationExecutions = new Set<string>();

function buildRetryFailureContext(input: {
  decisionReasonCode?: unknown;
  decisionSource?: unknown;
  workerResult?: {
    worker_status?: unknown;
    blocker_reason?: unknown;
    claimed_outcome?: unknown;
    compressed_history?: unknown;
    suggested_next_step?: unknown;
  };
  verification?: {
    verified_status?: unknown;
    notes?: unknown;
  };
}): Record<string, unknown> {
  return {
    decision_reason_code: input.decisionReasonCode,
    decision_source: input.decisionSource,
    worker_status: input.workerResult?.worker_status,
    blocker_reason: input.workerResult?.blocker_reason,
    claimed_outcome: input.workerResult?.claimed_outcome,
    compressed_history: input.workerResult?.compressed_history,
    suggested_next_step: input.workerResult?.suggested_next_step,
    verification_status: input.verification?.verified_status,
    verification_notes: input.verification?.notes
  };
}

function buildAutomaticRetryMetadata(input: {
  metadata?: Record<string, unknown>;
  decisionReasonCode: unknown;
  source: "worker" | "verifier";
  retryAttempt: number;
  maxRetryCount: number;
  timestamp: string;
  subgoalId: string;
  executionId: string;
  workerResult: any;
  verification: any;
}): Record<string, unknown> {
  const failureContext = buildRetryFailureContext({
    decisionReasonCode: input.decisionReasonCode,
    decisionSource: input.source,
    workerResult: input.workerResult,
    verification: input.verification
  });

  // The next worker attempt consumes this guidance; retry is treated as
  // another attempt for the same subgoal, not a demand-level replan.
  const metadataWithGuidance = appendExecutionGuidance(input.metadata, {
    source: "retry",
    kind: "automatic_subgoal_retry",
    note: [
      `Automatic retry triggered by scheduler. Retry attempt ${input.retryAttempt} of ${input.maxRetryCount}.`,
      "Use the previous failure, verification notes, worker result, and accepted progress as the basis for the next attempt.",
      "Do not simply repeat the failed path unless the failure context indicates a transient runtime issue."
    ].join("\n"),
    created_at: input.timestamp,
    execution_id: input.executionId,
    subgoal_id: input.subgoalId,
    retry_attempt: input.retryAttempt,
    max_retry_count: input.maxRetryCount,
    failure_context: failureContext
  });

  // Retry history is the durable counter behind settings.runtime.max_retry_count.
  return appendRetryHistory(metadataWithGuidance, {
    execution_id: input.executionId,
    subgoal_id: input.subgoalId,
    source: "scheduler_auto_retry",
    note: String(input.decisionReasonCode ?? "retry_after_failed_verification"),
    created_at: input.timestamp,
    retry_attempt: input.retryAttempt,
    max_retry_count: input.maxRetryCount
  });
}

/**
 * 函数作用：处理验证完成事件并根据归并结果推进调度。
 *
 * 参数说明：
 * - event：验证完成事件。
 * - ctx：事件处理器上下文。
 *
 * 返回值：
 * - Promise<HandlerResult>：执行、子目标、需求和后续事件处理结果。
 */
export async function onVerificationCompleted(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  const subgoal = await ctx.repositories.subgoals.getById(event.subgoal_id ?? "");
  const execution = await ctx.repositories.executions.getById(event.execution_id ?? "");
  const demandSubgoals = (await ctx.repositories.subgoals.list()).filter((item) => item.demand_id === event.demand_id);
  const workerResultEvent = (await ctx.repositories.events.list())
    .filter((item) => item.execution_id === event.execution_id && item.event_type === EventType.WORKER_RESULT_RECEIVED)
    .slice(-1)[0];
  if (!demand || !subgoal || !execution || !workerResultEvent) {
    logger.warn({ demandId: event.demand_id, subgoalId: event.subgoal_id, executionId: event.execution_id }, "忽略验证完成事件，因为必要记录未找到");
    return {};
  }
  if (reconcilingVerificationExecutions.has(execution.execution_id)) {
    logger.debug({ demandId: demand.demand_id, executionId: execution.execution_id }, "Ignoring duplicate verification completion while reconciliation is in flight");
    return {};
  }
  if (execution.state !== ExecutionState.VERIFYING) {
    logger.debug({ demandId: demand.demand_id, executionId: execution.execution_id, state: execution.state }, "Ignoring duplicate verification completion for execution that is no longer verifying");
    return {};
  }
  reconcilingVerificationExecutions.add(execution.execution_id);
  try {
  const workerResult = (workerResultEvent.payload as { worker_result: any }).worker_result;
  const verification = (event.payload as { verification_result: any }).verification_result;
  logger.info({ demandId: demand.demand_id, subgoalId: subgoal.subgoal_id, executionId: execution.execution_id, verificationStatus: verification.verified_status }, "正在归并验证结果");
  const outcome = ctx.reconciliation.reconcile({ demand, subgoal, execution, workerResult, verification });
  const projectedSubgoals = demandSubgoals.map((item) => item.subgoal_id === outcome.subgoal.subgoal_id ? outcome.subgoal : item);
  let retryRequest: {
    retryAttempt: number;
    maxRetryCount: number;
  } | null = null;

  if (verification.verified_status === "VERIFIED_DONE") {
    // clarification 阶段的 recon（demand 还没 clarified 完，OO=null）不参与"任务推进"判断 ——
    // 它的 outcome 已经在 reconciliation 里设置好（demand state 保持不动、replanRequested=true 让下游回灌发现）。
    // 如果在这里再硬推 ACTIVE，会撞状态机（PENDING_ALIGNMENT → ACTIVE 不合法）。
    const isReconInClarification = subgoal.kind === "recon" && !demand.operational_objective;
    if (!isReconInClarification) {
      const unfinishedStates = new Set([
        SubgoalState.PLANNED,
        SubgoalState.READY,
        SubgoalState.DISPATCHED,
        SubgoalState.EXECUTING,
        SubgoalState.VERIFYING
      ]);
      const hasOtherUnfinishedSubgoals = projectedSubgoals.some((item) => (
        item.subgoal_id !== outcome.subgoal.subgoal_id && unfinishedStates.has(item.state)
      ));

      const latestPlan = (demand.metadata?.latest_plan ?? null) as {
        overall_plan_outline?: Array<{ frontier_subgoal_ids?: string[] }>;
      } | null;

      const hasFuturePlanSteps = Array.isArray(latestPlan?.overall_plan_outline)
        ? latestPlan!.overall_plan_outline.some((item) => {
            const ids = Array.isArray(item.frontier_subgoal_ids) ? item.frontier_subgoal_ids : [];
            if (ids.length === 0) {
              return true;
            }
            return !ids.some((subgoalId) => projectedSubgoals.some((candidate) => candidate.subgoal_id === subgoalId && candidate.state === SubgoalState.DONE));
          })
        : false;

      if (hasOtherUnfinishedSubgoals) {
        outcome.demand.state = DemandState.ACTIVE;
        outcome.demand.current_phase = DemandPhase.EXECUTION;
        outcome.demand.progress_percent = Math.min(95, Math.max(outcome.demand.progress_percent, 70));
        outcome.missionCompleted = false;
        outcome.replanRequested = false;
      } else if (hasFuturePlanSteps) {
        outcome.demand.state = DemandState.ACTIVE;
        outcome.demand.current_phase = DemandPhase.PLANNING;
        outcome.demand.progress_percent = Math.min(95, Math.max(outcome.demand.progress_percent, 75));
        outcome.missionCompleted = false;
        outcome.replanRequested = true;
      }
    }
  }

  if (outcome.decisionReasonCode) {
    logger.info({ demandId: demand.demand_id, subgoalId: subgoal.subgoal_id, reasonCode: outcome.decisionReasonCode }, "Verification result needs recovery handling");
    const settings = await ctx.repositories.loadSettings();
    const retryHistory = readRetryHistory(demand.metadata)
      .filter((item) => item.subgoal_id === subgoal.subgoal_id);
    const retryBudgetAvailable = retryHistory.length < settings.runtime.max_retry_count;

    // Failed verification first becomes an unattended retry for this same
    // subgoal while budget remains; human decision is the fallback.
    if (retryBudgetAvailable) {
      const retryAttempt = retryHistory.length + 1;
      const retryTimestamp = nowIso();
      logger.info({
        demandId: demand.demand_id,
        subgoalId: subgoal.subgoal_id,
        executionId: execution.execution_id,
        reasonCode: outcome.decisionReasonCode,
        retryAttempt,
        maxRetryCount: settings.runtime.max_retry_count
      }, "Verification failure is being retried automatically for the same subgoal");

      outcome.demand.state = DemandState.ACTIVE;
      outcome.demand.current_phase = DemandPhase.REVIEW;
      outcome.demand.active_decision_id = null;
      outcome.demand.metadata = buildAutomaticRetryMetadata({
        metadata: demand.metadata,
        decisionReasonCode: outcome.decisionReasonCode,
        source: verification.verified_status === "UNVERIFIABLE" ? "verifier" : "worker",
        retryAttempt,
        maxRetryCount: settings.runtime.max_retry_count,
        timestamp: retryTimestamp,
        subgoalId: subgoal.subgoal_id,
        executionId: execution.execution_id,
        workerResult,
        verification
      });
      outcome.subgoal.state = SubgoalState.READY;
      outcome.missionCompleted = false;
      outcome.replanRequested = false;
      outcome.decisionReasonCode = undefined;
      outcome.decisionPrompt = undefined;
      retryRequest = {
        retryAttempt,
        maxRetryCount: settings.runtime.max_retry_count
      };
    } else {
      logger.info({
        demandId: demand.demand_id,
        subgoalId: subgoal.subgoal_id,
        reasonCode: outcome.decisionReasonCode,
        retryCount: retryHistory.length,
        maxRetryCount: settings.runtime.max_retry_count
      }, "Verification failure exhausted automatic retry budget and needs user decision");
      outcome.demand.state = DemandState.PENDING_DECISION;
      outcome.demand.current_phase = DemandPhase.REVIEW;
      outcome.missionCompleted = false;
      outcome.replanRequested = false;
    }
  }

  assertTransition("demand", demand.state, outcome.demand.state, DEMAND_TRANSITIONS);
  assertTransition("subgoal", subgoal.state, outcome.subgoal.state, SUBGOAL_TRANSITIONS);
  assertTransition("execution", execution.state, outcome.execution.state, EXECUTION_TRANSITIONS);
  const reconciliationTimestamp = nowIso();
  const waitingOn = outcome.decisionReasonCode
    ? "user_decision"
    : outcome.replanRequested || outcome.missionCompleted || retryRequest
      ? null
      : "scheduler";
  await ctx.repositories.demands.upsert({
    ...outcome.demand,
    metadata: patchRuntimeSession(outcome.demand.metadata, {
      phase: outcome.demand.current_phase,
      waiting_on: waitingOn,
      progress_note: `Verification: ${verification.verified_status}`
    }, reconciliationTimestamp),
    updated_at: reconciliationTimestamp
  });
  await ctx.repositories.subgoals.upsert(outcome.subgoal);
  await ctx.repositories.executions.upsert(outcome.execution);
  await syncWorkerExecutionSlots(
    execution.worker_id,
    ctx,
    verification.verified_status === "FAILED" || verification.verified_status === "UNVERIFIABLE"
      ? extractWorkerError(workerResult)
      : null
  );
  for (const memory of ctx.memoryManager.createExecutionMemories({
    demandId: demand.demand_id,
    workerResult,
    verification
  })) {
    await ctx.repositories.memory.upsert(memory);
  }
  logger.info({
    demandId: demand.demand_id,
    subgoalId: subgoal.subgoal_id,
    executionId: execution.execution_id,
    demandState: outcome.demand.state,
    subgoalState: outcome.subgoal.state,
    executionState: outcome.execution.state,
    replanRequested: outcome.replanRequested,
    missionCompleted: outcome.missionCompleted
  }, "验证归并结果已保存");

  const events: SchedulerEvent<unknown>[] = [
    createEvent(
      EventType.RECONCILIATION_COMPLETED,
      {
        verification_status: verification.verified_status,
        decision_id: null,
        mission_completed: outcome.missionCompleted,
        replan_requested: outcome.replanRequested,
        retry_requested: retryRequest !== null,
        retry_attempt: retryRequest?.retryAttempt
      },
      {
        demand_id: demand.demand_id,
        subgoal_id: subgoal.subgoal_id,
        execution_id: execution.execution_id,
        worker_id: execution.worker_id
      }
    )
  ];

  if (verification.verified_status === "VERIFIED_DONE") {
    const unlockedSubgoalIds = collectUnlockedPlannedSubgoals(outcome.demand, projectedSubgoals);
    if (unlockedSubgoalIds.length > 0) {
      logger.info({ demandId: demand.demand_id, unlockedSubgoalIds }, "验证后已解锁计划中的子目标");
    }
    for (const unlockedSubgoalId of unlockedSubgoalIds) {
      events.push(
        createEvent(
          EventType.SUBGOAL_MARKED_READY,
          {
            dependency_check: {
              satisfied_dependencies: ["prior_plan_items_done"],
              remaining_dependencies: []
            }
          },
          {
            demand_id: demand.demand_id,
            subgoal_id: unlockedSubgoalId
          }
        )
      );
    }
  }

  if (retryRequest) {
    logger.info({
      demandId: demand.demand_id,
      subgoalId: subgoal.subgoal_id,
      executionId: execution.execution_id,
      retryAttempt: retryRequest.retryAttempt
    });
    events.push(
      createEvent(
        EventType.SUBGOAL_RETRY_REQUESTED,
        {
          reason: "retry_after_failed_verification",
          previous_execution_id: execution.execution_id,
          retry_attempt: retryRequest.retryAttempt,
          max_retry_count: retryRequest.maxRetryCount
        },
        {
          demand_id: demand.demand_id,
          subgoal_id: subgoal.subgoal_id,
          execution_id: execution.execution_id,
          worker_id: execution.worker_id
        }
      )
    );
  } else if (outcome.decisionReasonCode && outcome.decisionPrompt) {
    const settings = await ctx.repositories.loadSettings();
    const blockerCode = typeof workerResult.blocker_reason?.code === "string"
      ? workerResult.blocker_reason.code
      : "";
    const isClaudeCodeAsk = blockerCode.startsWith("claude_code_");
    const adapterMeta = (workerResult.adapter_meta ?? {}) as Record<string, unknown>;
    const claudeAskSignal = adapterMeta.claude_ask_signal as
      | { source?: string; prompt?: string; options?: Array<{ label?: string; description?: string }>; raw?: unknown }
      | null
      | undefined;

    // Claude Code 询问类决策直接用原问句，避免 LLM 改写丢精度
    const prompt = isClaudeCodeAsk
      ? outcome.decisionPrompt
      : await ctx.decisionService.buildPrompt({
          demand,
          settings,
          source: verification.verified_status === "UNVERIFIABLE" ? "verifier" : "worker",
          reasonCode: outcome.decisionReasonCode,
          fallbackPrompt: outcome.decisionPrompt
        });

    const decisionMetadata = isClaudeCodeAsk
      ? {
          claude_code: {
            ask_source: claudeAskSignal?.source ?? null,
            options: Array.isArray(claudeAskSignal?.options) ? claudeAskSignal!.options : [],
            session_id: typeof adapterMeta.claude_session_id === "string" ? adapterMeta.claude_session_id : null,
            blocker_code: blockerCode,
            raw: claudeAskSignal?.raw ?? null
          }
        }
      : undefined;

    const decision = ctx.decisionService.createRequest({
      demandId: demand.demand_id,
      source: verification.verified_status === "UNVERIFIABLE" ? "verifier" : "worker",
      reasonCode: outcome.decisionReasonCode,
      prompt,
      subgoalId: subgoal.subgoal_id,
      executionId: execution.execution_id,
      metadata: decisionMetadata
    });
    logger.info({
      demandId: demand.demand_id,
      subgoalId: subgoal.subgoal_id,
      executionId: execution.execution_id,
      decisionId: decision.decision_id,
      isClaudeCodeAsk,
      blockerCode
    }, "已根据验证结果创建决策请求");
    events.push(
      createEvent(EventType.DECISION_REQUEST_CREATED, { decision_request: decision }, {
        demand_id: demand.demand_id,
        subgoal_id: subgoal.subgoal_id,
        execution_id: execution.execution_id,
        decision_id: decision.decision_id
      })
    );
  } else if (outcome.replanRequested) {
    // 单一入口：reconciliation.reconCompletion 告诉我们这个 recon 完成应该往哪里推。
    // 不再 reviewHandlers 自己按 verified_status 枚举值白名单分流 ——
    // 那种白名单设计漏一个值就静默走错路（参见 9adc397 hotfix）。
    if (outcome.reconCompletion) {
      const completion = outcome.reconCompletion;
      const activeReconExecutions = await listActiveOtherReconExecutions(
        ctx,
        demand.demand_id,
        execution.execution_id
      );
      // 直接转引用，避免漏掉 ReconFinding 上未来新增的字段（之前 rebuild 漏了 failed）。
      const currentFinding = completion.finding;
      const freshDemand = await ctx.repositories.demands.getById(demand.demand_id);
      const existingBuffer = Array.isArray(freshDemand?.metadata?.recon_findings_buffer)
        ? (freshDemand!.metadata!.recon_findings_buffer as Array<Record<string, unknown>>)
        : [];

      if (activeReconExecutions.length > 0) {
        const nextBuffer = [...existingBuffer, currentFinding];
        await ctx.repositories.demands.upsert({
          ...freshDemand!,
          metadata: {
            ...(freshDemand!.metadata ?? {}),
            recon_findings_buffer: nextBuffer
          },
          updated_at: nowIso()
        });
        logger.info({
          demandId: demand.demand_id,
          subgoalId: subgoal.subgoal_id,
          bufferedCount: nextBuffer.length,
          stillActiveReconCount: activeReconExecutions.length
        }, "Recon 完成但同 demand 还有别的 recon 在跑,发现暂存等待汇总");
      } else {
        const allFindings = [...existingBuffer, currentFinding]
          .map((f) => [
            `Recon subgoal: ${String(f.subgoal_title ?? "(untitled)")}`,
            f.claimed_outcome ? `Worker summary: ${String(f.claimed_outcome)}` : "",
            f.compressed_history ? `Detailed trace:\n${String(f.compressed_history)}` : ""
          ].filter(Boolean).join("\n\n"))
          .join("\n\n---\n\n");

        await ctx.repositories.demands.upsert({
          ...freshDemand!,
          metadata: {
            ...(freshDemand!.metadata ?? {}),
            recon_findings_buffer: undefined
          },
          updated_at: nowIso()
        });

        // reconciliation 已经决定好下游路径,这里只查路由表 publish 对应事件。
        // 用 switch 而不是 if/else，TypeScript 会在 ReconNextStep 加新值时报编译错误，
        // 不会像之前 isReconReplan 那样静默走错路。
        switch (completion.nextStep) {
          case "clarifier_feedback": {
            logger.info({
              demandId: demand.demand_id,
              subgoalId: subgoal.subgoal_id,
              bufferedCount: existingBuffer.length + 1,
              findingsLen: allFindings.length
            }, "所有 recon 已完成，把累积发现回灌给 clarifier");
            events.push(
              createEvent(
                EventType.USER_INPUT_RECEIVED,
                {
                  input_text: allFindings,
                  input_kind: "recon_findings",
                  source: "scheduler",
                  session_tag: null
                },
                { demand_id: demand.demand_id }
              )
            );
            break;
          }
          case "planner_replan": {
            logger.info({
              demandId: demand.demand_id,
              subgoalId: subgoal.subgoal_id,
              bufferedCount: existingBuffer.length + 1
            }, "所有 recon 已完成，触发 planner 重新规划");
            events.push(
              createEvent(EventType.REPLAN_REQUESTED, { reason: "recon_completed" as EventReason }, { demand_id: demand.demand_id })
            );
            break;
          }
          default: {
            // 编译期穷举校验：如果 ReconNextStep 加了新值，这里 TS 会报 "Type 'X' is not assignable to type 'never'"。
            const _exhaustive: never = completion.nextStep;
            throw new Error(`Unhandled ReconNextStep: ${JSON.stringify(_exhaustive)}`);
          }
        }
      }
    } else {
      // 非 recon 的 PARTIAL replan：走隐式路径，不审核
      logger.info({
        demandId: demand.demand_id,
        subgoalId: subgoal.subgoal_id,
        verifiedStatus: verification.verified_status
      }, "非 recon 的隐式重新规划");
      events.push(
        createEvent(EventType.REPLAN_REQUESTED, { reason: "replan_after_result" }, { demand_id: demand.demand_id })
      );
    }
  } else if (outcome.missionCompleted) {
    logger.info({ demandId: demand.demand_id }, "验证结果已完成任务");
    events.push(
      createEvent(EventType.MISSION_COMPLETED, { summary: "Mission completed after verified execution" }, { demand_id: demand.demand_id })
    );
  }

  return { events };
  } finally {
    reconcilingVerificationExecutions.delete(execution.execution_id);
  }
}

/**
 * Handles an unattended retry for the same subgoal after failed verification.
 * This is deliberately separate from demand-level replan: no new frontier is
 * generated here; the scheduler creates another execution for the same
 * SubgoalContract with the recorded failure guidance attached to demand
 * metadata.
 */
export async function onSubgoalRetryRequested(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  const subgoal = await ctx.repositories.subgoals.getById(event.subgoal_id ?? "");
  const previousExecution = await ctx.repositories.executions.getById(event.execution_id ?? "");
  const settings = await ctx.repositories.loadSettings();
  if (!demand || !subgoal || !previousExecution || !demand.operational_objective) {
    logger.warn({
      demandId: event.demand_id,
      subgoalId: event.subgoal_id,
      executionId: event.execution_id
    }, "Ignoring subgoal retry request because required records are missing");
    return {};
  }
  if (isTerminalDemand(demand) || demand.state === DemandState.PAUSED) {
    logger.debug({ demandId: demand.demand_id, state: demand.state }, "Ignoring subgoal retry because demand is not schedulable");
    return {};
  }
  if ([SubgoalState.DONE, SubgoalState.FAILED, SubgoalState.CANCELLED].includes(subgoal.state)) {
    logger.warn({ demandId: demand.demand_id, subgoalId: subgoal.subgoal_id, state: subgoal.state }, "Ignoring subgoal retry because subgoal is terminal");
    return {};
  }

  const readySubgoal = subgoal.state === SubgoalState.READY
    ? subgoal
    : transitionSubgoal(subgoal, { state: SubgoalState.READY });
  if (readySubgoal !== subgoal) {
    await ctx.repositories.subgoals.upsert(readySubgoal);
  }

  const workers = await ctx.repositories.workers.list();
  const worker = ctx.dispatcher.selectWorker(workers, readySubgoal);
  if (!worker) {
    await ctx.repositories.subgoals.upsert(transitionSubgoal(readySubgoal, { state: SubgoalState.BLOCKED }));
    const prompt = await ctx.decisionService.buildPrompt({
      demand,
      settings,
      source: "scheduler",
      reasonCode: DecisionReasonCode.BLOCKED,
      fallbackPrompt: "No available worker could retry the failed subgoal"
    });
    const decision = ctx.decisionService.createRequest({
      demandId: demand.demand_id,
      source: "scheduler",
      reasonCode: DecisionReasonCode.BLOCKED,
      prompt,
      subgoalId: readySubgoal.subgoal_id,
      executionId: previousExecution.execution_id
    });
    return {
      events: [
        createEvent(EventType.DECISION_REQUEST_CREATED, { decision_request: decision }, {
          demand_id: demand.demand_id,
          subgoal_id: readySubgoal.subgoal_id,
          execution_id: previousExecution.execution_id,
          decision_id: decision.decision_id
        })
      ]
    };
  }

  const payload = event.payload as { retry_attempt?: number };
  const retryExecution = ctx.dispatcher.buildExecution({
    demand,
    subgoal: readySubgoal,
    worker,
    attempt: payload.retry_attempt ?? previousExecution.attempt + 1
  });
  const memorySnapshot = await ctx.memoryManager.getDispatchMemorySnapshot(ctx.repositories, demand.demand_id);
  const workspaceGrants = collectWorkspaceGrants(settings, demand);
  const packet = ctx.dispatcher.buildPacket({
    demand,
    subgoal: readySubgoal,
    execution: retryExecution,
    worker,
    workspaceRoot: settings.workspace_root,
    heartbeatSeconds: settings.runtime.heartbeat_interval_seconds,
    timeoutSeconds: settings.runtime.execution_timeout_seconds,
    memorySnapshot,
    workspaceGrants
  });

  logger.info({
    demandId: demand.demand_id,
    subgoalId: readySubgoal.subgoal_id,
    previousExecutionId: previousExecution.execution_id,
    retryExecutionId: retryExecution.execution_id,
    retryAttempt: retryExecution.attempt
  }, "Created retry execution for failed subgoal");

  return {
    events: [
      createEvent(EventType.EXECUTION_CREATED, { execution: retryExecution, dispatch_packet: packet }, {
        demand_id: demand.demand_id,
        subgoal_id: readySubgoal.subgoal_id,
        execution_id: retryExecution.execution_id,
        worker_id: worker.worker_id
      })
    ]
  };
}

/**
 * 函数作用：处理决策请求创建事件并推送给实时客户端。
 *
 * 参数说明：
 * - event：决策请求创建事件。
 * - ctx：事件处理器上下文。
 *
 * 返回值：
 * - Promise<HandlerResult>：决策请求广播结果。
 */
export async function onDecisionRequestCreated(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const payload = event.payload as { decision_request: any };
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (demand) {
    const reasonCode = payload.decision_request.reason_code;
    logger.info({ demandId: demand.demand_id, decisionId: payload.decision_request.decision_id, reasonCode }, "正在保存决策请求");

    // PATH_GRANT_REQUIRED 在 clarification 阶段（PENDING_ALIGNMENT）就会弹，
    // 状态机不允许 PENDING_ALIGNMENT → PENDING_DECISION 直推。
    // 此时保持 demand 当前 state/phase 不动，只挂上 active_decision_id + waiting_on=user_decision。
    // 用户答完决策后由 handlePathGrantDecision 自己负责推进状态。
    const isAlignmentTimeDecision = demand.state === DemandState.PENDING_ALIGNMENT;
    if (isAlignmentTimeDecision) {
      await ctx.repositories.demands.upsert(transitionDemand(demand, {
        active_decision_id: payload.decision_request.decision_id
      }, {
        phase: demand.current_phase,
        waiting_on: "user_decision",
        latest_checkpoint: payload.decision_request.decision_id,
        progress_note: `Decision required during alignment: ${reasonCode}`
      }));
    } else {
      const t = tryTransition("demand", demand.state, DemandState.PENDING_DECISION, DEMAND_TRANSITIONS);
      if (t.ok) {
        await ctx.repositories.demands.upsert(transitionDemand(demand, {
          state: DemandState.PENDING_DECISION,
          current_phase: DemandPhase.REVIEW,
          active_decision_id: payload.decision_request.decision_id
        }, {
          phase: DemandPhase.REVIEW,
          waiting_on: "user_decision",
          latest_checkpoint: payload.decision_request.decision_id,
          progress_note: `Decision required: ${reasonCode}`
        }));
      } else {
        // 不能合法转 PENDING_DECISION（例如 demand 处于未预料的源状态），降级：保持源状态，
        // 但仍挂上 active_decision_id 让 UI 显示决策卡。af656df 仅特判了 PENDING_ALIGNMENT；
        // 这是把同类防御扩展到所有非法源状态，避免下一次新增 enum / 边角 case 重现 Class B 静默卡死。
        logger.warn({
          demandId: demand.demand_id,
          decisionId: payload.decision_request.decision_id,
          reasonCode,
          fromState: demand.state,
          skipReason: t.reason
        }, "demand state 不允许转 PENDING_DECISION，保持源状态只挂 active_decision_id");
        await ctx.repositories.demands.upsert(transitionDemand(demand, {
          active_decision_id: payload.decision_request.decision_id
        }, {
          phase: demand.current_phase,
          waiting_on: "user_decision",
          latest_checkpoint: payload.decision_request.decision_id,
          progress_note: `Decision required (state preserved: ${demand.state}): ${reasonCode}`
        }));
      }
    }
  } else {
    logger.warn({ demandId: event.demand_id, decisionId: payload.decision_request.decision_id }, "正在保存决策请求，但未找到对应需求");
  }
  await ctx.repositories.decisions.upsert(payload.decision_request);
  return {};
}

/**
 * 函数作用：处理决策响应事件并执行对应动作。
 *
 * 参数说明：
 * - event：决策响应事件。
 * - ctx：事件处理器上下文。
 *
 * 返回值：
 * - Promise<HandlerResult>：决策关闭、状态更新和后续事件发布结果。
 */
/**
 * 函数作用：处理 PLAN_REVIEW 决策的用户响应。
 *
 * 注意事项：
 * - PROVIDE_INFO 强制走 replan 路径，不受 classifyDecisionReplyIntent 影响。
 * - APPROVE 时根据决策 metadata.plan_review.frontier_subgoal_ids 找到 PLANNED 状态的 subgoal 批量发 SUBGOAL_MARKED_READY。
 */
async function handlePlanReviewDecision(
  event: SchedulerEvent,
  ctx: HandlerContext,
  decision: DecisionRequest,
  demand: Demand,
  payload: { decision_response: { action: DecisionAction; note?: string | null; payload?: Record<string, unknown> } }
): Promise<HandlerResult> {
  void event;
  const action = payload.decision_response.action;
  const note = (payload.decision_response.note ?? "").trim();
  const timestamp = nowIso();
  const planReviewMeta = (decision.metadata?.plan_review as Record<string, unknown> | undefined) ?? {};
  const latestPlan = demand.metadata?.latest_plan as Record<string, unknown> | undefined;
  const frontierIds: string[] = Array.isArray(planReviewMeta.frontier_subgoal_ids)
    ? (planReviewMeta.frontier_subgoal_ids as unknown[]).filter((id): id is string => typeof id === "string")
    : Array.isArray(latestPlan?.frontier_subgoal_ids)
      ? (latestPlan!.frontier_subgoal_ids as unknown[]).filter((id): id is string => typeof id === "string")
      : [];

  if (action === DecisionAction.APPROVE) {
    await ctx.repositories.decisions.upsert({
      ...decision,
      status: "RESOLVED" as any,
      resolved_at: timestamp
    });

    // 暂停态批准 = 恢复执行。暂停时的 frontier subgoal 处于 BLOCKED（不是 PLANNED），
    // 常规的"解锁 PLANNED frontier"对它们无效，会让 demand 进 ACTIVE 却没有 live 工作。
    // 走 DEMAND_RESUMED 复用恢复路径（READY/PLANNING → REPLAN_REQUESTED resume → 重新规划并继续）。
    if (planReviewMeta.origin === "pause") {
      await ctx.repositories.demands.upsert(transitionDemand(demand, {
        active_decision_id: null
      }, {
        progress_note: "Paused plan approved by user; resuming"
      }));
      logger.info({ demandId: demand.demand_id, decisionId: decision.decision_id }, "暂停态 plan-review 批准，恢复执行");
      return {
        events: [createEvent(EventType.DEMAND_RESUMED, { action: "resume" }, { demand_id: demand.demand_id })]
      };
    }

    await ctx.repositories.demands.upsert(transitionDemand(demand, {
      state: DemandState.ACTIVE,
      current_phase: DemandPhase.EXECUTION,
      active_decision_id: null
    }, {
      phase: DemandPhase.EXECUTION,
      waiting_on: "worker_result",
      progress_note: "Plan approved by user; unlocking frontier subgoals"
    }));

    const matchingSubgoals = (await ctx.repositories.subgoals.list()).filter((sg) =>
      sg.demand_id === demand.demand_id
      && frontierIds.includes(sg.subgoal_id)
      && sg.state === SubgoalState.PLANNED
    );
    logger.info({
      demandId: demand.demand_id,
      decisionId: decision.decision_id,
      frontierIds,
      unlockedSubgoalCount: matchingSubgoals.length
    }, "Plan 已通过审核，准备解锁前沿 subgoals");

    return {
      events: matchingSubgoals.map((sg) => createEvent(
        EventType.SUBGOAL_MARKED_READY,
        { dependency_check: { satisfied_dependencies: [], remaining_dependencies: [] } },
        { demand_id: demand.demand_id, subgoal_id: sg.subgoal_id }
      ))
    };
  }

  if (action === DecisionAction.PROVIDE_INFO) {
    if (!note) {
      logger.info({ demandId: demand.demand_id, decisionId: decision.decision_id }, "Plan review 反馈为空，保持决策打开");
      return {};
    }

    const settings = await ctx.repositories.loadSettings();
    const assistantReply = await ctx.decisionService.buildFollowUp({
      demand,
      settings,
      decision,
      userReply: note
    });
    const updatedDecisionMetadata = ctx.decisionService.appendConversationTurns(decision.metadata, [
      { role: "user", content: note, created_at: timestamp },
      { role: "assistant", content: assistantReply, created_at: timestamp }
    ]);
    const nextDemandMetadata = appendExecutionGuidance(demand.metadata, {
      source: "user",
      kind: "plan_review_feedback",
      note,
      created_at: timestamp,
      decision_id: decision.decision_id
    });

    await ctx.repositories.decisions.upsert({
      ...decision,
      status: "RESOLVED" as any,
      resolved_at: timestamp,
      metadata: updatedDecisionMetadata
    });
    await ctx.repositories.demands.upsert(transitionDemand(demand, {
      state: DemandState.READY,
      current_phase: DemandPhase.PLANNING,
      active_decision_id: null,
      metadata: nextDemandMetadata
    }, {
      phase: DemandPhase.PLANNING,
      waiting_on: null,
      progress_note: "Plan review feedback accepted, requesting replan"
    }));

    logger.info({ demandId: demand.demand_id, decisionId: decision.decision_id }, "Plan review 收到反馈，触发重新规划");
    return {
      events: [
        createEvent(
          EventType.REPLAN_REQUESTED,
          { reason: "replan_after_decision", note, source: "plan_review" },
          { demand_id: demand.demand_id }
        )
      ]
    };
  }

  if (action === DecisionAction.REJECT || action === DecisionAction.CANCEL_DEMAND) {
    await ctx.repositories.decisions.upsert({
      ...decision,
      status: "RESOLVED" as any,
      resolved_at: timestamp
    });
    logger.info({ demandId: demand.demand_id, decisionId: decision.decision_id, action }, "Plan review 被拒绝/取消，关闭 demand");
    return {
      events: [
        createEvent(
          EventType.DEMAND_CANCELLED,
          { action: "cancel", note: note || `plan_review_${String(action).toLowerCase()}` },
          { demand_id: demand.demand_id }
        )
      ]
    };
  }

  // PAUSE：关掉当前决策并挂起 demand；STOP 等同 cancel
  await ctx.repositories.decisions.upsert({
    ...decision,
    status: "RESOLVED" as any,
    resolved_at: timestamp
  });
  if (action === DecisionAction.PAUSE) {
    return {
      events: [createEvent(EventType.DEMAND_PAUSED, { action: "pause", note: note || undefined }, { demand_id: demand.demand_id })]
    };
  }
  return {
    events: [createEvent(EventType.DEMAND_CANCELLED, { action: "cancel", note: note || "plan_review_stop" }, { demand_id: demand.demand_id })]
  };
}

/**
 * 函数作用：处理 PATH_GRANT_REQUIRED 决策的用户响应。
 *
 * 注意事项：
 * - APPROVE：把 pending_workspace_grant_path 写入 demand.metadata.workspace_grants（去重）；
 *   若 payload.remember 为 true，还把它追加到 settings.workspace_grants。
 * - 然后从 demand.metadata.pending_clarification_payload 取回澄清结果，
 *   发出 DEMAND_CLARIFICATION_COMPLETED 继续后续 planning 流程。
 * - REJECT / CANCEL_DEMAND：取消 demand。
 */
async function handlePathGrantDecision(
  event: SchedulerEvent,
  ctx: HandlerContext,
  decision: DecisionRequest,
  demand: Demand,
  payload: { decision_response: { action: DecisionAction; note?: string | null; payload?: Record<string, unknown> } }
): Promise<HandlerResult> {
  void event;
  const action = payload.decision_response.action;
  const note = (payload.decision_response.note ?? "").trim();
  const remember = payload.decision_response.payload?.remember === true;
  const timestamp = nowIso();

  const pendingPath = (demand.metadata?.pending_workspace_grant_path as string | undefined) ?? null;
  const pendingPayload = demand.metadata?.pending_clarification_payload as
    | {
        clarified_demand: string;
        operational_objective: {
          acceptance_criteria?: string[];
          constraints?: string[];
          [k: string]: unknown;
        };
        clarification_summary?: string;
      }
    | undefined;

  if (action === DecisionAction.REJECT || action === DecisionAction.CANCEL_DEMAND) {
    await ctx.repositories.decisions.upsert({
      ...decision,
      status: "RESOLVED" as any,
      resolved_at: timestamp
    });
    logger.info({ demandId: demand.demand_id, decisionId: decision.decision_id, action }, "PATH_GRANT 被拒绝，取消 demand");
    return {
      events: [
        createEvent(
          EventType.DEMAND_CANCELLED,
          { action: "cancel", note: note || `path_grant_${String(action).toLowerCase()}` },
          { demand_id: demand.demand_id }
        )
      ]
    };
  }

  if (action !== DecisionAction.APPROVE) {
    logger.info({ demandId: demand.demand_id, decisionId: decision.decision_id, action }, "PATH_GRANT 收到非批准动作，保持决策打开");
    return {};
  }

  if (!pendingPath || !pendingPayload) {
    logger.warn({ demandId: demand.demand_id, decisionId: decision.decision_id }, "PATH_GRANT APPROVE 但缺少 pending 元数据，按取消处理");
    await ctx.repositories.decisions.upsert({
      ...decision,
      status: "RESOLVED" as any,
      resolved_at: timestamp
    });
    return {
      events: [
        createEvent(
          EventType.DEMAND_CANCELLED,
          { action: "cancel", note: "path_grant_missing_payload" },
          { demand_id: demand.demand_id }
        )
      ]
    };
  }

  // 1. 写入 demand 级授权
  const existingDemandGrants: Array<{ path: string; granted_at: string; remember?: boolean }> =
    Array.isArray(demand.metadata?.workspace_grants)
      ? (demand.metadata?.workspace_grants as Array<{ path: string; granted_at: string; remember?: boolean }>)
      : [];
  const alreadyInDemand = existingDemandGrants.some((g) => g && g.path === pendingPath);
  const nextDemandGrants = alreadyInDemand
    ? existingDemandGrants
    : [...existingDemandGrants, { path: pendingPath, granted_at: timestamp, remember }];

  // 2. 永久授权：写入 settings.workspace_grants
  if (remember) {
    const settings = await ctx.repositories.loadSettings();
    const existingSettingsGrants: Array<{ path: string; granted_at: string }> =
      Array.isArray(settings.workspace_grants)
        ? (settings.workspace_grants as Array<{ path: string; granted_at: string }>)
        : [];
    const alreadyInSettings = existingSettingsGrants.some((g) => g && g.path === pendingPath);
    if (!alreadyInSettings) {
      await ctx.repositories.settings.save({
        ...settings,
        workspace_grants: [...existingSettingsGrants, { path: pendingPath, granted_at: timestamp }],
        updated_at: timestamp
      } as any);
      logger.info({ demandId: demand.demand_id, path: pendingPath }, "Path grant 永久写入 settings.workspace_grants");
    }
  }

  // 3. 关闭决策，clear pending payload，进入 planning
  await ctx.repositories.decisions.upsert({
    ...decision,
    status: "RESOLVED" as any,
    resolved_at: timestamp
  });

  const restMeta = { ...(demand.metadata ?? {}) } as Record<string, unknown>;
  delete restMeta.pending_clarification_payload;
  delete restMeta.pending_workspace_grant_path;
  restMeta.workspace_grants = nextDemandGrants;

  await ctx.repositories.demands.upsert(transitionDemand(demand, {
    state: DemandState.READY,
    current_phase: DemandPhase.PLANNING,
    active_decision_id: null,
    metadata: restMeta
  }, {
    phase: DemandPhase.PLANNING,
    waiting_on: null,
    progress_note: `Path grant approved (${remember ? "remembered" : "once"})`
  }));

  logger.info({
    demandId: demand.demand_id,
    decisionId: decision.decision_id,
    path: pendingPath,
    remember
  }, "PATH_GRANT 已批准，恢复 planning 流程");

  return {
    events: [
      createEvent(
        EventType.DEMAND_CLARIFICATION_COMPLETED,
        {
          clarified_demand: pendingPayload.clarified_demand,
          operational_objective: pendingPayload.operational_objective as any,
          acceptance_criteria: Array.isArray(pendingPayload.operational_objective?.acceptance_criteria)
            ? pendingPayload.operational_objective.acceptance_criteria
            : [],
          constraints: Array.isArray(pendingPayload.operational_objective?.constraints)
            ? pendingPayload.operational_objective.constraints
            : [],
          clarification_summary: pendingPayload.clarification_summary ?? ""
        },
        { demand_id: demand.demand_id }
      )
    ]
  };
}

export async function onDecisionResponseReceived(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const payload = event.payload as { decision_response: { action: DecisionAction; note?: string; payload?: Record<string, unknown> } };
  const decision = await ctx.repositories.decisions.getById(event.decision_id ?? "");
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (!decision || !demand) {
    logger.warn({ demandId: event.demand_id, decisionId: event.decision_id }, "忽略决策响应，因为未找到决策或需求");
    return {};
  }
  if (decision.status !== DecisionStatus.OPEN) {
    // 守卫：决策已被解决 / 取代 / 取消（例如重复提交，或回复了一张已被新计划 EXPIRED 的旧 plan-review 卡）。
    // 直接忽略，避免对 stale 决策再触发一轮 replan 造成级联重复。前端会在下次 demand_view 刷新后看到卡消失。
    logger.info({
      demandId: demand.demand_id,
      decisionId: decision.decision_id,
      status: decision.status
    }, "忽略对非 OPEN 决策的响应（stale / 已取代 / 重复提交）");
    return {};
  }
  const hasActiveExecutions = await demandHasActiveExecutions(demand.demand_id, ctx);
  const settings = await ctx.repositories.loadSettings();
  logger.info({ demandId: demand.demand_id, decisionId: decision.decision_id, action: payload.decision_response.action, hasActiveExecutions, reasonCode: decision.reason_code }, "正在处理决策响应");

  if (decision.reason_code === DecisionReasonCode.PLAN_REVIEW) {
    return handlePlanReviewDecision(event, ctx, decision, demand, payload);
  }

  if (decision.reason_code === DecisionReasonCode.PATH_GRANT_REQUIRED) {
    return handlePathGrantDecision(event, ctx, decision, demand, payload);
  }

  if (payload.decision_response.action === DecisionAction.PROVIDE_INFO) {
    const note = payload.decision_response.note?.trim();
    if (!note) {
      logger.debug({ demandId: demand.demand_id, decisionId: decision.decision_id }, "忽略空的决策补充信息回复");
      return {};
    }
    const rawReplyIntent = classifyDecisionReplyIntent(note);
    const replyIntent = rawReplyIntent === "retry" ? "chat" : rawReplyIntent;
    const timestamp = nowIso();
    const assistantReply = await ctx.decisionService.buildFollowUp({
      demand,
      settings,
      decision,
      userReply: note
    });
    const updatedDecisionMetadata = ctx.decisionService.appendConversationTurns(decision.metadata, [
      { role: "user", content: note, created_at: timestamp },
      { role: "assistant", content: assistantReply, created_at: timestamp }
    ]);

    if (replyIntent === "chat" || hasActiveExecutions) {
      logger.info({ demandId: demand.demand_id, decisionId: decision.decision_id, replyIntent }, "决策对话已更新");
      await ctx.repositories.decisions.upsert({
        ...decision,
        status: "OPEN" as any,
        resolved_at: null,
        metadata: updatedDecisionMetadata
      });

      await ctx.repositories.demands.upsert(transitionDemand(demand, {
        state: DemandState.PENDING_DECISION,
        current_phase: DemandPhase.REVIEW,
        active_decision_id: decision.decision_id,
        updated_at: timestamp
      }, {
        phase: DemandPhase.REVIEW,
        waiting_on: "user_decision",
        latest_checkpoint: decision.decision_id,
        progress_note: "Decision conversation updated"
      }));
      return {};
    }

    logger.info({ demandId: demand.demand_id, decisionId: decision.decision_id, replyIntent }, "决策指导已接受，准备请求重新规划");
    const nextDemandMetadata = appendExecutionGuidance(demand.metadata, {
      source: replyIntent,
      kind: "decision_guidance",
      note,
      created_at: timestamp,
      decision_id: decision.decision_id,
      execution_id: decision.execution_id ?? null,
      subgoal_id: decision.subgoal_id ?? null
    });

    await ctx.repositories.decisions.upsert({
      ...decision,
      status: "RESOLVED" as any,
      resolved_at: timestamp,
      metadata: updatedDecisionMetadata
    });

    await ctx.repositories.demands.upsert(transitionDemand(demand, {
      state: DemandState.READY,
      current_phase: DemandPhase.PLANNING,
      active_decision_id: null,
      metadata: nextDemandMetadata
    }, {
      phase: DemandPhase.PLANNING,
      waiting_on: null,
      progress_note: `Decision guidance accepted: ${replyIntent}`
    }));

    return {
      events: [
        createEvent(
          EventType.REPLAN_REQUESTED,
          { reason: "replan_after_decision" },
          { demand_id: demand.demand_id }
        )
      ]
    };
  }

  await ctx.repositories.decisions.upsert({
    ...decision,
    status: "RESOLVED" as any,
    resolved_at: nowIso()
  });

  if (hasActiveExecutions) {
    const openDecisions = (await ctx.repositories.decisions.list()).filter((item) => (
      item.demand_id === demand.demand_id
      && item.status === "OPEN"
      && item.decision_id !== decision.decision_id
    ));

    const nextState = openDecisions.length > 0 ? DemandState.PENDING_DECISION : DemandState.ACTIVE;
    const nextPhase = openDecisions.length > 0 ? DemandPhase.REVIEW : DemandPhase.EXECUTION;
    await ctx.repositories.demands.upsert(transitionDemand(demand, {
      state: nextState,
      current_phase: nextPhase,
      active_decision_id: openDecisions[0]?.decision_id ?? null
    }, {
      phase: nextPhase,
      waiting_on: openDecisions.length > 0 ? "user_decision" : "worker_result",
      latest_checkpoint: openDecisions[0]?.decision_id ?? undefined,
      progress_note: "Decision resolved"
    }));
  } else if (
    payload.decision_response.action !== DecisionAction.PAUSE
    && payload.decision_response.action !== DecisionAction.CANCEL_DEMAND
  ) {
    await ctx.repositories.demands.upsert(transitionDemand(demand, {
      state: DemandState.READY,
      current_phase: DemandPhase.PLANNING,
      active_decision_id: null
    }, {
      phase: DemandPhase.PLANNING,
      waiting_on: null,
      progress_note: "Decision resolved"
    }));
  }

  if (payload.decision_response.action === DecisionAction.PAUSE) {
    logger.info({ demandId: demand.demand_id, decisionId: decision.decision_id }, "决策请求暂停需求");
    return {
      events: [createEvent(EventType.DEMAND_PAUSED, { action: "pause", note: payload.decision_response.note }, { demand_id: demand.demand_id })]
    };
  }

  if (payload.decision_response.action === DecisionAction.CANCEL_DEMAND) {
    logger.info({ demandId: demand.demand_id, decisionId: decision.decision_id }, "决策请求取消需求");
    return {
      events: [createEvent(EventType.DEMAND_CANCELLED, { action: "cancel", note: payload.decision_response.note }, { demand_id: demand.demand_id })]
    };
  }

  if (payload.decision_response.action === DecisionAction.STOP) {
    const events: SchedulerEvent<unknown>[] = [];
    if (event.execution_id) {
      logger.info({ demandId: demand.demand_id, decisionId: decision.decision_id, executionId: event.execution_id }, "决策请求停止执行");
      events.push(createEvent(
        EventType.EXECUTION_STOP_REQUESTED,
        { reason: payload.decision_response.note ?? "decision_stop" },
        collectEventRefs(event)
      ));
    }
    events.push(createEvent(EventType.REPLAN_REQUESTED, { reason: "replan_after_decision" }, { demand_id: demand.demand_id }));
    return { events };
  }

  if (hasActiveExecutions) {
    logger.info({ demandId: demand.demand_id, decisionId: decision.decision_id }, "决策已解决，但仍有活跃执行");
    return {};
  }

  logger.info({ demandId: demand.demand_id, decisionId: decision.decision_id }, "决策已解决，准备请求重新规划");
  return {
    events: [createEvent(EventType.REPLAN_REQUESTED, { reason: "replan_after_decision" }, { demand_id: demand.demand_id })]
  };
}

/**
 * 函数作用：处理归并完成事件。归并副作用已由 onVerificationCompleted 完成，
 * 本 handler 仅作为通知链路终点便于观测。后续若引入跨需求统计或外部上报，可在此挂副作用。
 */
export async function onReconciliationCompleted(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  void ctx;
  const payload = event.payload as {
    verification_status?: string;
    mission_completed?: boolean;
    replan_requested?: boolean;
    retry_requested?: boolean;
    decision_id?: string | null;
  };
  logger.info({
    demandId: event.demand_id,
    subgoalId: event.subgoal_id,
    executionId: event.execution_id,
    verificationStatus: payload.verification_status,
    missionCompleted: payload.mission_completed,
    replanRequested: payload.replan_requested,
    retryRequested: payload.retry_requested,
    decisionId: payload.decision_id ?? null
  }, "归并完成事件已观测");
  return {};
}
