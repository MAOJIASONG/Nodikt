/**
 * 文件名称：sessionState.ts
 * 文件作用：运行会话状态辅助模块，负责维护需求元数据中的对话历史、阶段和执行指导。
 *
 * 主要职责：
 * 1. 对 runtime_session 元数据进行补丁式更新。
 * 2. 读取和追加用户、系统、助手的对话轮次。
 * 3. 识别决策回复意图并追加执行指导信息。
 *
 * 依赖模块：
 * - domain：需求阶段枚举。
 *
 * 注意事项：
 * - 会话状态存放在 metadata 中，读写时要兼容历史数据缺失或结构不完整。
 * - 意图识别规则应保持可解释，避免误触发重试或重规划。
 */
import { DemandPhase } from "../../../domain/index.js";

export type ConversationTurn = {
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

export type DecisionReplyIntent = "chat" | "retry" | "revise";

export type RuntimeSessionPatch = {
  phase?: DemandPhase;
  waiting_on?: string | null;
  frontier_subgoal_ids?: string[];
  latest_checkpoint?: string;
  progress_note?: string;
};

/**
 * 函数作用：补丁式更新需求元数据中的运行会话状态。
 *
 * 参数说明：
 * - metadata：原始元数据。
 * - patch：需要更新的会话字段。
 *
 * 返回值：
 * - Record<string, unknown>：更新后的元数据对象。
 */
export function patchRuntimeSession(
  metadata: Record<string, unknown> | undefined,
  patch: RuntimeSessionPatch,
  timestamp: string
): Record<string, unknown> {
  const current = (
    metadata?.runtime_session && typeof metadata.runtime_session === "object"
      ? metadata.runtime_session as Record<string, unknown>
      : {}
  );
  return {
    ...(metadata ?? {}),
    runtime_session: {
      ...current,
      ...(patch.phase ? { phase: patch.phase } : {}),
      ...(patch.waiting_on !== undefined ? { waiting_on: patch.waiting_on } : {}),
      ...(patch.frontier_subgoal_ids ? { frontier_subgoal_ids: patch.frontier_subgoal_ids } : {}),
      ...(patch.latest_checkpoint ? { latest_checkpoint: patch.latest_checkpoint } : {}),
      ...(patch.progress_note ? { progress_note: patch.progress_note } : {}),
      last_progress_at: timestamp
    }
  };
}

/**
 * 函数作用：读取需求运行会话中的对话历史。
 *
 * 参数说明：
 * - metadata：需求元数据。
 *
 * 返回值：
 * - ConversationTurn[]：对话历史列表。
 */
export function readConversationHistory(metadata?: Record<string, unknown>): ConversationTurn[] {
  const raw = metadata?.conversation_history;
  return Array.isArray(raw) ? raw as ConversationTurn[] : [];
}

/**
 * 函数作用：向需求运行会话追加对话轮次。
 *
 * 参数说明：
 * - metadata：原始元数据。
 * - turns：需要追加的对话轮次。
 *
 * 返回值：
 * - Record<string, unknown>：更新后的元数据对象。
 */
export function appendConversationTurns(
  metadata: Record<string, unknown> | undefined,
  turns: ConversationTurn[]
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    conversation_history: [...readConversationHistory(metadata), ...turns]
  };
}

/**
 * 函数作用：识别用户在决策回复中的意图。
 *
 * 参数说明：
 * - note：用户回复文本。
 *
 * 返回值：
 * - DecisionReplyIntent：chat、retry 或 revise。
 */
export function classifyDecisionReplyIntent(note: string): DecisionReplyIntent {
  const normalized = note.toLowerCase();

  const retryPatterns = [
    "重试",
    "重新试",
    "再试一次",
    "重新跑",
    "再跑一次",
    "继续跑",
    "继续执行",
    "继续做",
    "继续干",
    "去干",
    "开始干",
    "开始做",
    "直接做",
    "重新开始",
    "重新来",
    "继续推进",
    "继续往下",
    "往下做",
    "往下推进",
    "继续处理",
    "处理一下",
    "replan",
    "re-plan",
    "plan again",
    "retry",
    "rerun",
    "run again",
    "try again"
  ];

  const revisePatterns = [
    "修改",
    "调整",
    "改一下",
    "改成",
    "改为",
    "换成",
    "按这个改",
    "按这个做",
    "照这个改",
    "照这个做",
    "按这个方案",
    "按这个方向",
    "优化",
    "不要",
    "把",
    "change ",
    "modify",
    "adjust",
    "revise"
  ];

  if (retryPatterns.some((item) => normalized.includes(item))) {
    return "retry";
  }

  if (revisePatterns.some((item) => normalized.includes(item))) {
    return "revise";
  }

  return "chat";
}

/**
 * 函数作用：向需求元数据追加执行指导记录。
 *
 * 参数说明：
 * - metadata：原始元数据。
 * - guidance：指导内容。
 *
 * 返回值：
 * - Record<string, unknown>：更新后的元数据对象。
 */
export function appendExecutionGuidance(
  metadata: Record<string, unknown> | undefined,
  guidance: { source: string; note: string; created_at: string }
): Record<string, unknown> {
  const raw = metadata?.execution_guidance;
  const existing = Array.isArray(raw) ? raw as Array<Record<string, unknown>> : [];
  return {
    ...(metadata ?? {}),
    execution_guidance: [...existing, guidance]
  };
}
