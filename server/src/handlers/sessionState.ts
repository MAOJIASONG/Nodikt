import { DemandPhase } from "../domain/index.js";

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

export function readConversationHistory(metadata?: Record<string, unknown>): ConversationTurn[] {
  const raw = metadata?.conversation_history;
  return Array.isArray(raw) ? raw as ConversationTurn[] : [];
}

export function appendConversationTurns(
  metadata: Record<string, unknown> | undefined,
  turns: ConversationTurn[]
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    conversation_history: [...readConversationHistory(metadata), ...turns]
  };
}

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
