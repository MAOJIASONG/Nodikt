import type { CSSProperties } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { apiRequest } from "./api/client";
import { createNodiktSocket } from "./api/socket";
import { useT } from "./i18n/context";
import type { Language } from "./i18n/messages";
import type {
  AdapterType,
  ConversationMessage,
  Decision,
  DecisionAction,
  Demand,
  DemandDetail,
  DemandEvent,
  Execution,
  ModelConfig,
  RuntimeType,
  Settings,
  Worker,
  WorkerRegistrationPayload,
  WorkerResultEventPayload,
  WorkerTile
} from "./api/types";

type TFn = (key: string, vars?: Record<string, string | number>) => string;

type WorkerDraft = {
  name: string;
  adapter_type: AdapterType;
  runtime_type: RuntimeType;
  max_concurrency: number;
  capabilities: string;
  workspace_root: string;
  command: string;
  args: string;
  endpoint: string;
};

const EMPTY_SETTINGS: Settings = {
  version: "v1",
  updated_at: "",
  models: {
    primary: { provider: "", model: "", base_url: "", api_key: "" },
    planner: { provider: "", model: "", base_url: "", api_key: "" },
    verifier: { provider: "", model: "", base_url: "", api_key: "" },
    ops_backup: { provider: "", model: "", base_url: "", api_key: "" }
  },
  workspace_root: "",
  runtime: {
    heartbeat_interval_seconds: 30,
    execution_timeout_seconds: 600,
    max_retry_count: 1,
    llm_timeout_seconds: 60
  },
  worker_policy: {
    skill_install_scope: "workspace_only"
  },
  default_autonomy_level: "L1",
  default_permissions: {
    can_modify_files: true,
    can_run_commands: true,
    can_install_dependencies: false,
    can_open_pr: false
  }
};

const DEFAULT_WORKER_DRAFT: WorkerDraft = {
  name: "Claude Code",
  adapter_type: "claude_code",
  runtime_type: "local_command",
  max_concurrency: 4,
  capabilities: "code_generation, file_edit, command_execution",
  workspace_root: "",
  command: "",
  args: "",
  endpoint: ""
};

// ---------- 执行进度相关 helpers / 组件 -----------------------------------------
//
// 痛点：subgoal 派给 worker 后可能跑 1-10 分钟，期间页面所有静态信息都不变，用户体感"卡死"。
// 这一段做的事：(1) 每秒自增的时间钩子，(2) 已运行/相对时间格式化，(3) 一个 RunningProgress 卡，
// 在 subgoal stage === "running" 时贴在卡片下方，展示动态时间、心跳新鲜度、tool trace 进度。

/** 每秒触发一次 re-render 的 hook，返回当前 Date.now() (ms)。仅在 enabled 时启动 setInterval。 */
function useTickingClock(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [enabled, intervalMs]);
  return now;
}

function formatElapsedShort(elapsedMs: number, t: TFn): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return t("time.just_started");
  const sec = Math.floor(elapsedMs / 1000);
  if (sec < 60) return t("time.seconds", { n: sec });
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return t("time.minutes_seconds", { m: min, s: rem.toString().padStart(2, "0") });
  const hr = Math.floor(min / 60);
  return t("time.hours_minutes", { h: hr, m: (min % 60).toString().padStart(2, "0") });
}

function formatRelativeShort(fromIso: string | null | undefined, nowMs: number, t: TFn): string {
  if (!fromIso) return t("common.dash");
  const time = new Date(fromIso).getTime();
  if (!Number.isFinite(time)) return t("common.dash");
  const diff = Math.max(0, nowMs - time);
  const sec = Math.floor(diff / 1000);
  if (sec < 5) return t("time.just_now");
  if (sec < 60) return t("time.seconds_ago", { n: sec });
  const min = Math.floor(sec / 60);
  if (min < 60) return t("time.minutes_ago", { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t("time.hours_ago", { n: hr });
  return t("time.days_ago", { n: Math.floor(hr / 24) });
}

/**
 * 把后端 EventType 枚举翻译成自然语言，给 Recent Events 时间线展示。
 * 返回 { label, tone }：label 是要给客户看的中文句子，tone 用于决定卡片样式色。
 * 缺省 fallback 是原 event_type 字符串 + neutral —— 避免 enum 新增时前端崩。
 */
function humanizeEvent(event: DemandEvent, t: TFn): { label: string; tone: "neutral" | "info" | "success" | "warning" | "danger" } {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.event_type) {
    case "USER_INPUT_RECEIVED": {
      const kind = typeof payload.input_kind === "string" ? payload.input_kind : "";
      if (kind === "recon_findings") return { label: t("event.user_input.recon"), tone: "info" };
      if (kind === "clarification_reply") return { label: t("event.user_input.clarify_reply"), tone: "info" };
      return { label: t("event.user_input.demand"), tone: "info" };
    }
    case "DEMAND_CREATED":
      return { label: t("event.demand_created"), tone: "info" };
    case "DEMAND_CLARIFICATION_COMPLETED":
      return { label: t("event.demand_clarified"), tone: "success" };
    case "PLAN_GENERATED":
      return { label: t("event.plan_generated"), tone: "success" };
    case "SUBGOAL_CREATED":
      return { label: t("event.subgoal_created"), tone: "info" };
    case "SUBGOAL_MARKED_READY":
      return { label: t("event.subgoal_ready"), tone: "info" };
    case "EXECUTION_CREATED":
      return { label: t("event.execution_created"), tone: "info" };
    case "EXECUTION_DISPATCHED":
      return { label: t("event.execution_dispatched"), tone: "info" };
    case "WORKER_RESULT_RECEIVED": {
      const wr = payload.worker_result as { worker_status?: string | null } | undefined;
      const status = wr?.worker_status ?? "";
      if (status === "DONE") return { label: t("event.worker_done"), tone: "success" };
      if (status === "FAILED") return { label: t("event.worker_failed"), tone: "danger" };
      if (status === "NEED_HELP" || status === "BLOCKED") return { label: t("event.worker_blocked"), tone: "warning" };
      return { label: t("event.worker_result"), tone: "info" };
    }
    case "VERIFICATION_COMPLETED": {
      const vr = payload.verification_result as { verified_status?: string } | undefined;
      const status = vr?.verified_status ?? typeof payload.verification_status === "string" ? payload.verification_status : "";
      if (status === "VERIFIED_DONE") return { label: t("event.verified_done"), tone: "success" };
      if (status === "PARTIAL") return { label: t("event.verified_partial"), tone: "info" };
      if (status === "FAILED") return { label: t("event.verified_failed"), tone: "danger" };
      if (status === "UNVERIFIABLE") return { label: t("event.unverifiable"), tone: "warning" };
      return { label: t("event.verified_completed"), tone: "info" };
    }
    case "RECONCILIATION_COMPLETED": {
      const replan = Boolean(payload.replan_requested);
      const mission = Boolean(payload.mission_completed);
      if (mission) return { label: t("event.mission_complete"), tone: "success" };
      if (replan) return { label: t("event.reconcile_replan"), tone: "info" };
      return { label: t("event.reconcile_done"), tone: "info" };
    }
    case "SUBGOAL_RETRY_REQUESTED":
      return { label: t("event.subgoal_retry"), tone: "warning" };
    case "DECISION_REQUEST_CREATED": {
      const dr = payload.decision_request as { reason_code?: string } | undefined;
      const reason = dr?.reason_code ?? "";
      if (reason === "PLAN_REVIEW") return { label: t("event.decision.plan_review"), tone: "warning" };
      if (reason === "PATH_GRANT_REQUIRED") return { label: t("event.decision.path_grant"), tone: "warning" };
      if (reason === "OPS_ALERT") return { label: t("event.decision.ops_alert"), tone: "danger" };
      if (reason === "UNVERIFIABLE_RESULT") return { label: t("event.decision.unverifiable"), tone: "warning" };
      if (reason === "BLOCKED") return { label: t("event.decision.blocked"), tone: "warning" };
      return { label: t("event.decision.generic"), tone: "warning" };
    }
    case "DECISION_RESPONSE_RECEIVED": {
      const dr = payload.decision_response as { action?: string } | undefined;
      const action = dr?.action ?? "";
      if (action === "Approve") return { label: t("event.decision_response.approve"), tone: "success" };
      if (action === "Reject") return { label: t("event.decision_response.reject"), tone: "danger" };
      if (action === "ProvideInfo") return { label: t("event.decision_response.provide_info"), tone: "info" };
      if (action === "CancelDemand") return { label: t("event.decision_response.cancel"), tone: "danger" };
      return { label: t("event.decision_response.received"), tone: "info" };
    }
    case "REPLAN_REQUESTED":
      return { label: t("event.replan"), tone: "info" };
    case "DEMAND_PAUSED":
      return { label: t("event.paused"), tone: "warning" };
    case "DEMAND_RESUMED":
      return { label: t("event.resumed"), tone: "info" };
    case "DEMAND_CANCELLED":
      return { label: t("event.cancelled"), tone: "danger" };
    case "EXECUTION_STOP_REQUESTED":
      return { label: t("event.exec_stop"), tone: "warning" };
    case "EXECUTION_TIMEOUT_DETECTED":
      return { label: t("event.exec_timeout"), tone: "warning" };
    case "WORKER_HEALTH_CHECKED": {
      const ok = Boolean(payload.ok);
      return ok
        ? { label: t("event.worker_health_ok"), tone: "neutral" }
        : { label: t("event.worker_health_fail"), tone: "warning" };
    }
    case "OPS_RECOVERY_ATTEMPTED":
      return { label: t("event.ops_recover"), tone: "info" };
    case "OPS_RECOVERY_FAILED":
      return { label: t("event.ops_recover_failed"), tone: "danger" };
    case "OPS_ALERT":
      return { label: t("event.ops_alert"), tone: "warning" };
    case "MISSION_COMPLETED":
      return { label: t("event.mission_complete"), tone: "success" };
    default:
      return { label: event.event_type, tone: "neutral" };
  }
}

/** 从 adapter_meta 里抽取 worker 当前粗粒度进度（已完成工具调用步数 + 最后一步描述）。 */
function extractToolProgress(execution: Execution): { steps: number; lastAction: string | null } {
  const meta = execution.adapter_meta as Record<string, unknown> | undefined;
  if (!meta) return { steps: 0, lastAction: null };
  const traces = meta.claude_tool_traces;
  if (!Array.isArray(traces) || traces.length === 0) return { steps: 0, lastAction: null };
  const last = traces[traces.length - 1] as Record<string, unknown> | undefined;
  let lastAction: string | null = null;
  if (last && typeof last === "object") {
    const name = typeof last.name === "string" ? last.name : "";
    const input = typeof last.input_preview === "string" ? last.input_preview : "";
    // 取 input 前 60 字符，避免决策卡膨胀
    const briefInput = input.length > 0 ? input.replace(/\s+/g, " ").slice(0, 60) : "";
    if (name && briefInput) {
      lastAction = `${name}(${briefInput}${input.length > 60 ? "…" : ""})`;
    } else if (name) {
      lastAction = name;
    }
  }
  return { steps: traces.length, lastAction };
}

/**
 * 执行中状态的进度条：跑了多久、心跳新鲜度、已完成工具步数、当前在做什么。
 * 仅在 stage === "running"（EXECUTING / DISPATCHED / VERIFYING / RUNNING / QUEUED）时挂载。
 *
 * execution 允许为 null —— subgoal.state 推进得比 execution row 写入快时会有短暂窗口
 * 拿不到 execution；这时仍渲染一个 "排队中…" 的占位卡，让用户至少看见这块区域。
 */
function RunningProgress({ execution }: { execution: Execution | null }) {
  const { t } = useT();
  const now = useTickingClock(true, 1000);

  // execution=null 的早期窗口：subgoal 显示 running 但 execution row 还没出现
  if (!execution) {
    return (
      <div className="running-progress running-progress-queued">
        <div className="running-progress-row">
          <span className="running-progress-pulse" aria-hidden="true" />
          <span className="running-progress-label">{t("progress.queued")}</span>
          <span className="running-progress-elapsed">{t("progress.queued_handoff")}</span>
        </div>
        <div className="running-progress-meta">
          <span>{t("progress.queued_waiting")}</span>
        </div>
      </div>
    );
  }

  const startedMs = execution.started_at ? new Date(execution.started_at).getTime() : null;
  const elapsed = startedMs ? Math.max(0, now - startedMs) : 0;
  const { steps, lastAction } = extractToolProgress(execution);
  const heartbeatRelative = formatRelativeShort(execution.last_heartbeat_at, now, t);
  const heartbeatMs = execution.last_heartbeat_at
    ? Math.max(0, now - new Date(execution.last_heartbeat_at).getTime())
    : null;
  // 心跳超过 60 秒视为"可能卡住"（背景换警示色）
  const heartbeatStale = heartbeatMs !== null && heartbeatMs > 60_000;

  // 三种渲染态，让用户一眼看出系统在做什么：
  //   queued    —— started_at 还没回写（execution.state=QUEUED / DISPATCHED 刚派发瞬间）
  //   running   —— 正常跑（默认）
  //   stale     —— 心跳 60s+ 没刷，可能卡住（橙色警示）
  const renderState = !startedMs ? "queued" : heartbeatStale ? "stale" : "running";
  const stateLabel = renderState === "queued"
    ? t("progress.queued")
    : renderState === "stale"
      ? t("progress.stalled")
      : t("progress.running");
  const elapsedText = startedMs
    ? t("progress.elapsed", { duration: formatElapsedShort(elapsed, t) })
    : t("progress.waiting_start");

  return (
    <div className={`running-progress running-progress-${renderState}`}>
      <div className="running-progress-row">
        <span className="running-progress-pulse" aria-hidden="true" />
        <span className="running-progress-label">{stateLabel}</span>
        <span className="running-progress-elapsed">{elapsedText}</span>
      </div>
      <div className="running-progress-meta">
        {steps > 0 ? <span>{t("progress.steps_done", { n: steps })}</span> : <span>{t("progress.waiting_first")}</span>}
        <span>·</span>
        <span title={execution.last_heartbeat_at ?? ""}>
          {execution.last_heartbeat_at ? t("progress.active_at", { ago: heartbeatRelative }) : t("progress.no_heartbeat")}
        </span>
      </div>
      {lastAction ? (
        <div className="running-progress-action" title={lastAction}>
          {t("progress.in_progress", { action: lastAction })}
        </div>
      ) : null}
    </div>
  );
}

export function App() {
  const { t, language, setLanguage } = useT();
  const [tab, setTab] = useState<"Dashboard" | "Workers" | "Settings">("Dashboard");
  const [settingsTab, setSettingsTab] = useState<"general" | "brain">("general");
  const [dashboardView, setDashboardView] = useState<"board" | "detail" | "create">("board");
  const [demands, setDemands] = useState<Demand[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [showWorkerCreateModal, setShowWorkerCreateModal] = useState(false);
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const [workerDraft, setWorkerDraft] = useState<WorkerDraft>(DEFAULT_WORKER_DRAFT);
  // Worker Detail 编辑表单的本地草稿：打开弹窗时从 worker 拷一份进来，Save 之前都不会写回 workers 列表。
  // capabilities 在 UI 上用 csv 字符串编辑，提交时再 parseCsv 一下。
  const [workerEditDraft, setWorkerEditDraft] = useState<{
    name: string;
    runtime_type: RuntimeType;
    workspace_root: string;
    capabilities: string;
    max_concurrency: number;
    endpoint: string;
  } | null>(null);
  const [workerEditSubmitting, setWorkerEditSubmitting] = useState(false);
  const [detail, setDetail] = useState<DemandDetail | null>(null);
  const [activeDemandId, setActiveDemandId] = useState<string | null>(null);
  const [newDemand, setNewDemand] = useState("");
  const [clarificationReply, setClarificationReply] = useState("");
  const [pausedInstruction, setPausedInstruction] = useState("");
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createModalExpanded, setCreateModalExpanded] = useState(false);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [replySubmitting, setReplySubmitting] = useState(false);
  const [assistantTyping, setAssistantTyping] = useState(false);
  const [controlSubmittingId, setControlSubmittingId] = useState<string | null>(null);
  const [boardDismissingId, setBoardDismissingId] = useState<string | null>(null);
  const [conversationPending, setConversationPending] = useState<ConversationMessage[]>([]);
  const [selectedSubgoalDialog, setSelectedSubgoalDialog] = useState<{ subgoalId: string; mode: "success" | "failed" | "issue" } | null>(null);
  const [subgoalDialogClosing, setSubgoalDialogClosing] = useState(false);
  const [planTransitionMode, setPlanTransitionMode] = useState<"idle" | "exiting" | "replanning">("idle");
  const [replanSubmitting, setReplanSubmitting] = useState(false);
  const [decisionNotes, setDecisionNotes] = useState<Record<string, string>>({});
  const [decisionSubmitting, setDecisionSubmitting] = useState<string | null>(null);
  const [expandedPlanItemId, setExpandedPlanItemId] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(EMPTY_SETTINGS);
  const [settingsDraft, setSettingsDraft] = useState<Settings>(EMPTY_SETTINGS);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsStatus, setSettingsStatus] = useState("");
  // Workspace Grants 输入框的临时值（添加按钮按下时取这个并清空）
  const [newGrantInput, setNewGrantInput] = useState("");
  const [workerSubmitting, setWorkerSubmitting] = useState(false);
  const boardCardRefs = useRef<Record<string, HTMLElement | null>>({});
  const previousBoardRects = useRef<Map<string, DOMRect>>(new Map());
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const subgoalDialogCloseTimerRef = useRef<number | null>(null);
  const planTransitionTimerRef = useRef<number | null>(null);
  const createSessionRef = useRef(0);
  const detailRequestRef = useRef(0);
  // 打开 Create Demand 弹窗之前的 activeDemandId 快照 —— 用 ref 而不是 state，
  // 避免它参与渲染。closeCreateModal 用它判断"应该回到哪个 demand 详情"。
  const previousActiveDemandIdRef = useRef<string | null>(null);
  const visibleTimelineEvents = detail
    ? detail.events.filter((item) => item.event_type !== "WORKER_HEARTBEAT_RECEIVED")
    : [];
  const hiddenHeartbeatCount = detail
    ? detail.events.filter((item) => item.event_type === "WORKER_HEARTBEAT_RECEIVED").length
    : 0;
  const activeDemandCount = demands.filter((item) => item.state === "ACTIVE" || item.state === "READY" || item.state === "PENDING_ALIGNMENT").length;
  const completedDemandCount = demands.filter((item) => item.state === "COMPLETED").length;
  const openDecisionCount = detail?.decisions.filter((item) => item.status === "OPEN").length ?? 0;
  const openDecisions = detail?.decisions.filter((item) => item.status === "OPEN") ?? [];

  type ActionRequiredKind = "decision" | "alignment" | "blocked" | "fault";
  type ActionRequiredEntry = {
    demand: Demand;
    kind: ActionRequiredKind;
    label: string;
    hint: string;
  };

  const ACTION_REQUIRED_TERMINAL_STATES = ["COMPLETED", "CANCELLED", "FAILED"];
  const actionRequiredEntries: ActionRequiredEntry[] = demands
    .map<ActionRequiredEntry | null>((demand) => {
      // 终态 demand（已完成 / 已取消 / 已失败）永远不"需要你处理"，直接跳过。
      // 否则一条 CANCELLED 但 metadata 仍残留 brain_error / clarification_question 的 demand
      // 会赖在"需要你处理"栏里（用户已经处理完了还显示在前面）。
      if (ACTION_REQUIRED_TERMINAL_STATES.includes(demand.state)) {
        return null;
      }
      // fault 优先于其它分类：brain LLM 坏了不是"澄清"也不是"决策"，用户改 Settings 才能救回来。
      // 不放在 alignment 后面，否则 PENDING_ALIGNMENT + brain_error 的情况会被先吞成"Clarify"。
      if (demandHasBrainError(demand)) {
        return {
          demand,
          kind: "fault",
          label: t("action_required.label.fault"),
          hint: t("action_required.hint.fault")
        };
      }
      if (demand.state === "PENDING_DECISION" || demand.active_decision_id) {
        return {
          demand,
          kind: "decision",
          label: t("action_required.label.decision"),
          hint: t("action_required.hint.decision")
        };
      }
      if (demand.state === "BLOCKED") {
        return {
          demand,
          kind: "blocked",
          label: t("action_required.label.blocked"),
          hint: t("action_required.hint.blocked")
        };
      }
      if (demand.state === "PENDING_ALIGNMENT" || demand.metadata?.clarification_question) {
        return {
          demand,
          kind: "alignment",
          label: t("action_required.label.clarify"),
          hint: t("action_required.hint.clarify")
        };
      }
      return null;
    })
    .filter((entry): entry is ActionRequiredEntry => entry !== null);

  const actionRequiredCount = actionRequiredEntries.length;
  // 中断计数只看 execution.state 处于活动态（与后端 ACTIVE_EXECUTION_STATES 对齐：
  // server/src/brain/scheduler/handlers/stateMachine.ts:34 = {QUEUED, RUNNING, VERIFYING}）。
  // 之前还 OR 了 latest_worker_status === "running"，会把 INTERRUPTED/DONE 但心跳字段从未更新的
  // 终态 execution 误算成"在跑"，使"中断 (N)"按钮始终亮着不归零。
  const ACTIVE_EXECUTION_STATES_FE = new Set(["RUNNING", "QUEUED", "VERIFYING"]);
  const runningExecutionCount = detail?.executions.filter((item) =>
    ACTIVE_EXECUTION_STATES_FE.has(item.state)
  ).length ?? 0;
  const assignedWorkerBySubgoalId = new Map(
    (detail?.executions ?? []).map((execution) => [execution.subgoal_id, execution.worker_id])
  );
  const executionBySubgoalId = new Map<string, Execution>();
  (detail?.executions ?? []).forEach((execution) => {
    const current = executionBySubgoalId.get(execution.subgoal_id);
    if (!current || current.updated_at < execution.updated_at) {
      executionBySubgoalId.set(execution.subgoal_id, execution);
    }
  });
  const latestDecisionBySubgoalId = new Map<string, Decision>();
  (detail?.decisions ?? []).forEach((decision) => {
    if (decision.subgoal_id && decision.status === "OPEN") {
      latestDecisionBySubgoalId.set(decision.subgoal_id, decision);
    }
  });
  const latestWorkerResultByExecutionId = new Map<string, WorkerResultEventPayload["worker_result"]>();
  (detail?.events ?? []).forEach((event) => {
    if (event.event_type === "WORKER_RESULT_RECEIVED") {
      const workerResult = (event.payload as WorkerResultEventPayload | undefined)?.worker_result;
      if (workerResult?.execution_id) {
        latestWorkerResultByExecutionId.set(workerResult.execution_id, workerResult);
      }
    }
  });
  const workerNameById = new Map(
    workers.map((worker) => [worker.worker_id, worker.name])
  );
  // demand 级聚合错误：用 subgoalStage 判定 "failed"，与计划面板的状态灯保持同一套口径。
  // 但用户主动中断 / 取消的 subgoal 不算"错误待处理"——它们是有意停止、已被 replan 取代，
  // 不该挂在面板上显示成"BLOCKED ... 暂无详情记录"。靠 execution INTERRUPTED/CANCELLED 或
  // subgoal CANCELLED 识别（兼容旧数据里中断后停在 BLOCKED 的 subgoal）。
  const failedSubgoals = (detail?.subgoals ?? []).filter((sg) => {
    const exec = executionBySubgoalId.get(sg.subgoal_id);
    const decision = latestDecisionBySubgoalId.get(sg.subgoal_id);
    if (sg.state === "CANCELLED") return false;
    if (exec && ["INTERRUPTED", "CANCELLED"].includes(exec.state)) return false;
    return subgoalStage(sg.state, exec, decision) === "failed";
  });

  function openSubgoalDialog(subgoalId: string, mode: "success" | "failed" | "issue") {
    if (subgoalDialogCloseTimerRef.current) {
      window.clearTimeout(subgoalDialogCloseTimerRef.current);
      subgoalDialogCloseTimerRef.current = null;
    }
    setSelectedSubgoalDialog({ subgoalId, mode });
    setSubgoalDialogClosing(false);
  }

  function closeSubgoalDialog() {
    if (!selectedSubgoalDialog || subgoalDialogClosing) {
      return;
    }
    setSubgoalDialogClosing(true);
    subgoalDialogCloseTimerRef.current = window.setTimeout(() => {
      setSelectedSubgoalDialog(null);
      setSubgoalDialogClosing(false);
      subgoalDialogCloseTimerRef.current = null;
    }, 220);
  }

  function invalidateDemandView(options?: { resetComposer?: boolean }) {
    createSessionRef.current += 1;
    detailRequestRef.current += 1;
    setActiveDemandId(null);
    setDetail(null);
    setCreateSubmitting(false);
    setDetailLoading(false);
    setReplySubmitting(false);
    setAssistantTyping(false);
    setConversationPending([]);
    setClarificationReply("");
    if (options?.resetComposer) {
      setNewDemand("");
    }
  }

  function workerLamp(worker: Worker): "online" | "offline" | "fault" {
    const status = (worker.status || "").toLowerCase();
    if (status === "error" || status === "failed" || status === "fault") {
      return "fault";
    }
    if (status === "idle" || status === "busy" || status === "online") {
      return "online";
    }
    return "offline";
  }

  const workerTiles: WorkerTile[] = workers.map((worker) => ({
    key: worker.worker_id,
    name: worker.name,
    subtitle: `${worker.adapter_type} / ${worker.runtime_type ?? "local_command"}`,
    capabilities: worker.capabilities,
    lamp: workerLamp(worker),
    status: worker.status,
    meta: worker.current_execution_ids?.length
      ? `${worker.current_execution_ids.length} active execution${worker.current_execution_ids.length === 1 ? "" : "s"}`
      : worker.config?.workspace_root
  }));

  function parseCsv(value: string): string[] {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function parseCommandArgs(value: string): string[] | undefined {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [trimmed];
    } catch {
      return trimmed.split(/\s+/).filter(Boolean);
    }
  }

  function updateWorkerDraft<K extends keyof WorkerDraft>(field: K, value: WorkerDraft[K]) {
    setWorkerDraft((current) => ({
      ...current,
      [field]: value
    }));
  }

  async function registerWorker() {
    const name = workerDraft.name.trim();
    const workspaceRoot = workerDraft.workspace_root.trim() || settings.workspace_root || settingsDraft.workspace_root;
    const capabilities = parseCsv(workerDraft.capabilities);

    if (!name || !workspaceRoot || capabilities.length === 0) {
      return;
    }

    const payload: WorkerRegistrationPayload = {
      name,
      adapter_type: workerDraft.adapter_type,
      runtime_type: workerDraft.runtime_type,
      max_concurrency: Math.max(1, Number(workerDraft.max_concurrency) || 1),
      capabilities,
      config: {
        workspace_root: workspaceRoot,
        ...(workerDraft.command.trim() ? { command: workerDraft.command.trim() } : {}),
        ...(parseCommandArgs(workerDraft.args) ? { args: parseCommandArgs(workerDraft.args) } : {}),
        ...(workerDraft.endpoint.trim() ? { endpoint: workerDraft.endpoint.trim() } : {})
      }
    };

    setWorkerSubmitting(true);
    try {
      const registered = await apiRequest<Worker>("/workers/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      setWorkers((current) => {
        const next = current.filter((worker) => worker.worker_id !== registered.worker_id);
        return [...next, registered];
      });
      setWorkerDraft({
        ...DEFAULT_WORKER_DRAFT,
        workspace_root: workspaceRoot
      });
      setShowWorkerCreateModal(false);
      await loadDashboard({ silent: true });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("workers.register_failed"));
    } finally {
      setWorkerSubmitting(false);
    }
  }

  /**
   * 重命名 worker —— 弹 prompt 让用户输入新名字，PATCH 后刷新列表。
   * 工作量小的"编辑"路径，避免做完整 edit 表单。
   */
  async function renameWorker(workerId: string, currentName: string) {
    const input = window.prompt(t("workers.rename_prompt"), currentName);
    if (input === null) return;
    const trimmed = input.trim();
    if (!trimmed || trimmed === currentName) return;
    try {
      const patched = await apiRequest<Worker>(`/workers/${workerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed })
      });
      setWorkers((current) => current.map((w) => (w.worker_id === workerId ? patched : w)));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("workers.rename_failed"));
    }
  }

  /**
   * 打开 Worker Detail 弹窗：从 worker 拷一份编辑草稿出来。
   * 用户改字段只动 workerEditDraft；点 Save 才 PATCH 到后端。
   */
  function openWorkerDetail(worker: Worker) {
    setSelectedWorkerId(worker.worker_id);
    setWorkerEditDraft({
      name: worker.name,
      runtime_type: (worker.runtime_type ?? "local_command") as RuntimeType,
      workspace_root: worker.config?.workspace_root ?? "",
      capabilities: worker.capabilities.join(", "),
      max_concurrency: worker.max_concurrency ?? 1,
      endpoint: worker.config?.endpoint ?? ""
    });
  }

  function closeWorkerDetail() {
    setSelectedWorkerId(null);
    setWorkerEditDraft(null);
    setWorkerEditSubmitting(false);
  }

  function updateWorkerEditDraft<K extends keyof NonNullable<typeof workerEditDraft>>(
    field: K,
    value: NonNullable<typeof workerEditDraft>[K]
  ) {
    setWorkerEditDraft((current) => (current ? { ...current, [field]: value } : current));
  }

  /**
   * PATCH /workers/:id 把编辑后的字段写回后端：
   *   name / runtime_type / workspace_root / capabilities / max_concurrency / endpoint
   * adapter_type / command / args 不在 UI 编辑范围（需要 adapter 重新 register，留给重建 worker 走）。
   */
  async function saveWorkerEdit() {
    if (!selectedWorkerId || !workerEditDraft) return;
    const name = workerEditDraft.name.trim();
    const workspaceRoot = workerEditDraft.workspace_root.trim();
    const capabilities = parseCsv(workerEditDraft.capabilities);
    const maxConcurrency = Math.max(1, Number(workerEditDraft.max_concurrency) || 1);
    if (!name || !workspaceRoot || capabilities.length === 0) {
      window.alert(t("workers.register_failed"));
      return;
    }
    setWorkerEditSubmitting(true);
    try {
      const patched = await apiRequest<Worker>(`/workers/${selectedWorkerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          runtime_type: workerEditDraft.runtime_type,
          workspace_root: workspaceRoot,
          capabilities,
          max_concurrency: maxConcurrency,
          endpoint: workerEditDraft.endpoint.trim()
        })
      });
      setWorkers((current) => current.map((w) => (w.worker_id === patched.worker_id ? patched : w)));
      closeWorkerDetail();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("workers.detail.save_failed"));
    } finally {
      setWorkerEditSubmitting(false);
    }
  }

  /**
   * 删除 worker —— 后端会拒绝带活跃 execution 的删除（409），UI 把原因报给用户。
   * 成功后从前端 workers 列表移除即可，下次 ws workers broadcast 会再次校准。
   */
  async function deleteWorker(workerId: string, displayName: string) {
    if (!window.confirm(t("workers.delete_confirm", { name: displayName }))) return;
    try {
      await apiRequest<void>(`/workers/${workerId}`, { method: "DELETE" });
      setWorkers((current) => current.filter((w) => w.worker_id !== workerId));
    } catch (error) {
      const msg = error instanceof Error ? error.message : t("workers.delete_failed");
      window.alert(msg);
    }
  }

  function stateTone(value: string): "success" | "warning" | "danger" | "neutral" | "info" {
    if (["COMPLETED", "DONE", "VERIFIED_DONE", "idle"].includes(value)) {
      return "success";
    }
    if (["PENDING_DECISION", "PENDING_ALIGNMENT", "VERIFYING", "REVIEW", "PAUSED"].includes(value)) {
      return "warning";
    }
    if (["FAILED", "BLOCKED", "TIMEOUT", "CANCELLED", "error"].includes(value)) {
      return "danger";
    }
    if (["ACTIVE", "RUNNING", "EXECUTING", "PLANNING"].includes(value)) {
      return "info";
    }
    return "neutral";
  }

  function demandProgressIndicator(demand: Demand): {
    tone: "success" | "warning" | "danger" | "info" | "neutral";
    progress: number;
    done: boolean;
  } {
    if (demand.state === "COMPLETED") {
      return { tone: "success", progress: 100, done: true };
    }

    if (["FAILED", "BLOCKED", "CANCELLED"].includes(demand.state)) {
      return { tone: "danger", progress: 78, done: false };
    }

    if (["PENDING_ALIGNMENT", "PENDING_DECISION", "PAUSED"].includes(demand.state) || ["ALIGNMENT", "REVIEW", "VERIFYING"].includes(demand.current_phase)) {
      return { tone: "warning", progress: 52, done: false };
    }

    if (["ACTIVE", "READY"].includes(demand.state) || ["PLANNING", "EXECUTION", "EXECUTING"].includes(demand.current_phase)) {
      // 进行中（含 recon 完成后等下一轮 plan 的窗口）用 info(蓝)而非 success(绿)。
      // 绿色专门留给 COMPLETED —— 否则 recon subgoal 成功后 demand 进 ACTIVE/PLANNING，
      // 绿灯+绿进度条会让用户误以为整个任务已经完成。
      return { tone: "info", progress: 72, done: false };
    }

    return { tone: "neutral", progress: 26, done: false };
  }

  function displayDemandTitle(demand: Demand): string {
    const raw = (demand.title || demand.clarified_demand || demand.initial_input || "").trim();
    if (raw.length <= 48) {
      return raw;
    }
    return `${raw.slice(0, 45).trim()}...`;
  }

  function demandNeedsClarification(demand: Demand): boolean {
    return demand.state === "PENDING_ALIGNMENT" || Boolean(demand.metadata?.clarification_question);
  }

  function demandBrainError(demand: Demand): { message?: string; error_name?: string; source?: string; at?: string } | null {
    const raw = demand.metadata?.brain_error;
    return raw && typeof raw === "object" ? (raw as { message?: string; error_name?: string; source?: string; at?: string }) : null;
  }
  function demandHasBrainError(demand: Demand): boolean {
    return demandBrainError(demand) !== null;
  }

  function demandLampTone(demand: Demand): "success" | "warning" | "danger" | "info" | "neutral" {
    if (demand.state === "COMPLETED") {
      return "success";
    }
    // brain LLM（planner/clarifier）故障留下的非终态错误标记 → 红灯。
    // demand 仍在自动重试，但用户应能立刻看到"出问题了"，而不是一直绿灯。
    // 后端在 planner/clarifier 下一次成功时自动清除该标记。
    if (demandHasBrainError(demand)) {
      return "danger";
    }
    if (["FAILED", "CANCELLED"].includes(demand.state)) {
      return "danger";
    }
    if (["PENDING_ALIGNMENT", "PENDING_DECISION", "PAUSED"].includes(demand.state)) {
      return "warning";
    }
    if (["ACTIVE", "READY"].includes(demand.state)) {
      // 进行中用 info(蓝)而非 success(绿)。绿灯只代表 COMPLETED ——
      // recon subgoal 成功后 demand 短暂进 ACTIVE/PLANNING 等下一轮 plan，
      // 这期间不该亮绿灯让用户误以为任务完成了。
      return "info";
    }
    return "neutral";
  }

  function subgoalStage(
    subgoalState: string,
    execution?: Execution,
    decision?: Decision
  ): "waiting" | "ready" | "running" | "success" | "failed" {
    const normalizedSubgoal = subgoalState.toUpperCase();
    const normalizedExecution = execution?.state.toUpperCase() ?? "";
    const normalizedWorker = execution?.latest_worker_status?.toUpperCase() ?? "";
    const normalizedResult = execution?.result_status?.toUpperCase() ?? "";
    const hasOpenDecision = decision?.status === "OPEN";

    if (
      ["FAILED", "BLOCKED", "CANCELLED"].includes(normalizedSubgoal) ||
      ["FAILED", "TIMEOUT", "CANCELLED", "INTERRUPTED"].includes(normalizedExecution) ||
      ["FAILED", "BLOCKED"].includes(normalizedResult) ||
      normalizedWorker === "ERROR"
    ) {
      return "failed";
    }

    if (
      ["DONE"].includes(normalizedSubgoal) ||
      normalizedExecution === "DONE" ||
      normalizedResult === "DONE"
    ) {
      return "success";
    }

    if (
      ["EXECUTING", "DISPATCHED", "VERIFYING"].includes(normalizedSubgoal) ||
      ["RUNNING", "QUEUED", "VERIFYING"].includes(normalizedExecution) ||
      normalizedWorker === "RUNNING"
    ) {
      return "running";
    }

    if (normalizedSubgoal === "READY") {
      return "ready";
    }

    if (hasOpenDecision) {
      return "ready";
    }

    return "waiting";
  }

  function stageLabel(stage: "waiting" | "ready" | "running" | "success" | "failed", decision?: Decision): string {
    if (stage === "ready" && decision?.status === "OPEN") {
      return t("stage.queued");
    }
    return {
      waiting: t("stage.waiting"),
      ready: t("stage.ready"),
      running: t("stage.running"),
      success: t("stage.success"),
      failed: t("stage.failed")
    }[stage];
  }

  function decisionActionLabel(action: string, reasonCode?: string | null): string {
    if (reasonCode === "PLAN_REVIEW") {
      const planReviewLabels: Record<string, string> = {
        Approve: t("decision_action.approve_plan"),
        ProvideInfo: t("decision_action.send_feedback"),
        Reject: t("decision_action.reject_plan"),
        CancelDemand: t("decision_action.cancel_demand")
      };
      if (planReviewLabels[action]) {
        return planReviewLabels[action];
      }
    }
    return {
      Approve: t("decision_action.approve"),
      Reject: t("decision_action.reject"),
      ProvideInfo: t("decision_action.provide_info"),
      CancelDemand: t("decision_action.cancel_demand")
    }[action] ?? action;
  }

  function decisionReasonLabel(reasonCode?: string | null): string {
    if (!reasonCode) return t("decision_reason.default");
    const friendly: Record<string, string> = {
      PLAN_REVIEW: t("decision_reason.plan_review"),
      PATH_GRANT_REQUIRED: t("decision_reason.path_grant_required"),
      MISSING_INFO: t("decision_reason.missing_info"),
      MISSING_PERMISSION: t("decision_reason.missing_permission"),
      INSTALL_REQUIRES_REVIEW: t("decision_reason.install_requires_review"),
      PLAN_CONFLICT: t("decision_reason.plan_conflict"),
      UNVERIFIABLE_RESULT: t("decision_reason.unverifiable_result"),
      HIGH_RISK_ACTION: t("decision_reason.high_risk_action"),
      BLOCKED: t("decision_reason.blocked"),
      OPS_ALERT: t("decision_reason.ops_alert")
    };
    return friendly[reasonCode] ?? reasonCode;
  }

  function decisionActionClass(action: string): string {
    if (["Reject", "Stop", "CancelDemand"].includes(action)) {
      return "ghost-button danger-button";
    }
    if (action === "Approve") {
      return "primary";
    }
    return "ghost-button";
  }

  function decisionActionNeedsNote(action: string): boolean {
    return action === "ProvideInfo";
  }

  function summarizeDecisionPrompt(prompt: string): string {
    try {
      const parsed = JSON.parse(prompt) as Record<string, unknown>;
      const sections: string[] = [];
      const pushText = (label: string, value: unknown) => {
        if (typeof value === "string" && value.trim().length > 0) {
          sections.push(`${label}\n${value.trim()}`);
        }
      };
      const pushList = (label: string, value: unknown) => {
        if (Array.isArray(value)) {
          const items = value
            .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
            .map((item) => `- ${item.trim()}`);
          if (items.length > 0) {
            sections.push(`${label}\n${items.join("\n")}`);
          }
        }
      };

      pushText(t("decision_section.current"), parsed.decision_prompt);
      pushText(t("decision_section.explanation"), parsed.explanation);
      pushText(t("decision_section.reason"), parsed.reason);
      pushText(t("decision_section.context"), parsed.context);
      pushText(t("decision_section.need_action"), parsed.human_input_required);
      pushText(t("decision_section.why_human"), parsed.why_human_input_required);
      pushText(t("decision_section.suggestion"), parsed.suggestion);
      pushText(t("decision_section.next_step"), parsed.next_step);
      pushList(t("decision_section.suggestions"), parsed.suggestions);
      pushList(t("decision_section.next_steps"), parsed.next_steps);
      pushList(t("decision_section.questions"), parsed.questions);

      return sections.join("\n\n") || prompt;
    } catch {
      return prompt;
    }
  }

  function rawSubgoalIssueText(
    execution?: Execution | null,
    workerResult?: WorkerResultEventPayload["worker_result"] | null,
    decision?: Decision | null
  ): string {
    return workerResult?.blocker_reason?.message
      || execution?.claimed_outcome
      || execution?.compressed_history
      || decision?.prompt
      || workerResult?.suggested_next_step
      || t("demand.no_detail");
  }

  function hasInspectableIssue(stage: "waiting" | "ready" | "running" | "success" | "failed", decision?: Decision): boolean {
    return stage === "success" || stage === "failed" || Boolean(decision?.status === "OPEN");
  }

  function shouldTriggerPlanReplan(note: string): boolean {
    const normalized = note.trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    return [
      "replan",
      "re-plan",
      "retry",
      "rerun",
      "run again",
      "重试",
      "继续干",
      "继续做",
      "继续跑",
      "继续执行",
      "重新跑",
      "重新规划",
      "重新计划",
      "重新来",
      "按这个改",
      "按这个做",
      "照这个改",
      "照这个做"
    ].some((keyword) => normalized.includes(keyword));
  }

  async function loadDashboard(options?: { silent?: boolean }) {
    if (!options?.silent) {
      setDashboardLoading(true);
    }
    try {
      const [nextDemands, nextWorkers, nextSettings] = await Promise.all([
        apiRequest<Demand[]>("/demands"),
        apiRequest<Worker[]>("/workers"),
        apiRequest<Settings>("/settings")
      ]);
      setDemands(nextDemands);
      setWorkers(nextWorkers);
      setSettings(nextSettings);
      if (!settingsDirty) {
        setSettingsDraft(nextSettings);
      }
    } finally {
      if (!options?.silent) {
        setDashboardLoading(false);
      }
    }
  }

  async function loadDemandDetail(demandId: string) {
    const requestId = ++detailRequestRef.current;
    setActiveDemandId(demandId);
    setDetailLoading(true);
    try {
      const nextDetail = await apiRequest<DemandDetail>(`/demands/${demandId}`);
      if (requestId !== detailRequestRef.current) {
        return;
      }
      setDetail(nextDetail);
      setTab("Dashboard");
      setDashboardView("detail");
    } finally {
      if (requestId === detailRequestRef.current) {
        setDetailLoading(false);
      }
    }
  }

  async function createDemand() {
    if (!newDemand.trim()) {
      return;
    }
    const createSessionId = ++createSessionRef.current;
    detailRequestRef.current += 1;
    setCreateSubmitting(true);
    setTab("Dashboard");
    setDashboardView("detail");
    setActiveDemandId(null);
    setDetail(null);
    setDetailLoading(true);
    try {
      const created = await apiRequest<Demand>("/demands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initial_input: newDemand })
      });

      if (createSessionId !== createSessionRef.current) {
        return;
      }

      setNewDemand("");
      setTab("Dashboard");
      setDashboardView("detail");
      if (created?.demand_id) {
        setActiveDemandId(created.demand_id);
      }
      await loadDashboard();
      if (createSessionId !== createSessionRef.current) {
        return;
      }
      if (created?.demand_id) {
        await loadDemandDetail(created.demand_id);
      }
    } catch (error) {
      setDashboardView("create");
      setDetailLoading(false);
      window.alert(error instanceof Error ? error.message : t("demand.create_failed"));
    } finally {
      if (createSessionId === createSessionRef.current) {
        setCreateSubmitting(false);
      }
    }
  }

  async function controlDemand(demandId: string, action: "pause" | "resume" | "cancel" | "interrupt", note?: string, options?: { returnToBoardAfterCancel?: boolean }) {
    setControlSubmittingId(demandId);
    try {
      await apiRequest<{ ok: true }>(`/demands/${demandId}/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, note })
      });
      await loadDashboard();
      if (activeDemandId === demandId && action !== "cancel") {
        await loadDemandDetail(demandId);
      }
      if (action === "cancel" && options?.returnToBoardAfterCancel) {
        setDetail(null);
        setActiveDemandId(null);
        setDashboardView("board");
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("demand.control_failed"));
    } finally {
      setControlSubmittingId(null);
      setBoardDismissingId((current) => (current === demandId ? null : current));
    }
  }

  async function interruptExecution(executionId: string, demandId: string, note?: string) {
    setControlSubmittingId(executionId);
    try {
      await apiRequest<{ ok: true }>(`/executions/${executionId}/interrupt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note })
      });
      await loadDashboard();
      if (activeDemandId === demandId) {
        await loadDemandDetail(demandId);
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("demand.interrupt_failed"));
    } finally {
      setControlSubmittingId(null);
    }
  }

  async function sendClarificationReplyText(rawText: string) {
    if (!detail) {
      return;
    }
    const replyText = rawText.trim();
    if (!replyText) {
      return;
    }
    const optimisticUserMessage: ConversationMessage = {
      role: "user",
      content: replyText,
      created_at: new Date().toISOString(),
      optimistic: true
    };

    setReplySubmitting(true);
    setAssistantTyping(true);
    setConversationPending([optimisticUserMessage]);
    setClarificationReply("");

    try {
      await apiRequest<{ ok: true }>(`/demands/${detail.demand.demand_id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input_text: replyText })
      });

      await loadDashboard();
      await loadDemandDetail(detail.demand.demand_id);
    } catch (error) {
      setClarificationReply(replyText);
      window.alert(error instanceof Error ? error.message : t("demand.reply_failed"));
    } finally {
      setReplySubmitting(false);
      setAssistantTyping(false);
      setConversationPending([]);
    }
  }

  async function sendClarificationReply() {
    return sendClarificationReplyText(clarificationReply);
  }

  async function saveSettings() {
    setSettingsSaving(true);
    try {
      const saved = await apiRequest<Settings>("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settingsDraft)
      });
      setSettings(saved);
      setSettingsDraft(saved);
      setSettingsDirty(false);
      setSettingsStatus(t("settings.saved"));
    } catch (error) {
      setSettingsStatus(error instanceof Error ? error.message : t("settings.save_failed"));
    } finally {
      setSettingsSaving(false);
    }
  }

  function decisionNoteFor(decisionId: string): string {
    return decisionNotes[decisionId] ?? "";
  }

  function updateDecisionNote(decisionId: string, value: string) {
    setDecisionNotes((current) => ({
      ...current,
      [decisionId]: value
    }));
  }

  async function respondToDecision(
    decisionId: string,
    action: DecisionAction,
    extraPayload?: Record<string, unknown>
  ) {
    if (!detail) {
      return;
    }

    const note = decisionNoteFor(decisionId).trim();
    const triggerReplanTransition = action === "ProvideInfo" && shouldTriggerPlanReplan(note);

    if (triggerReplanTransition) {
      setExpandedPlanItemId(null);
      setPlanTransitionMode("exiting");
      if (planTransitionTimerRef.current) {
        window.clearTimeout(planTransitionTimerRef.current);
      }
      planTransitionTimerRef.current = window.setTimeout(() => {
        setPlanTransitionMode("replanning");
        planTransitionTimerRef.current = null;
      }, 220);
      closeSubgoalDialog();
    }

    setDecisionSubmitting(decisionId);
    try {
      await apiRequest<{ ok: true }>(`/decisions/${decisionId}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          note: note || null,
          payload: extraPayload ?? {}
        })
      });

      setDecisionNotes((current) => {
        const next = { ...current };
        delete next[decisionId];
        return next;
      });
      await loadDashboard();
      await loadDemandDetail(detail.demand.demand_id);
      if (triggerReplanTransition) {
        setPlanTransitionMode("idle");
      }
      if (action !== "ProvideInfo") {
        closeSubgoalDialog();
      }
    } catch (error) {
      if (triggerReplanTransition) {
        setPlanTransitionMode("idle");
      }
      window.alert(error instanceof Error ? error.message : t("demand.decision_failed"));
    } finally {
      setDecisionSubmitting(null);
    }
  }

  async function requestReplan() {
    if (!detail) {
      return;
    }
    const note = window.prompt(
      t("demand.replan_prompt"),
      ""
    );
    if (note === null) {
      return;
    }

    setExpandedPlanItemId(null);
    setPlanTransitionMode("exiting");
    if (planTransitionTimerRef.current) {
      window.clearTimeout(planTransitionTimerRef.current);
    }
    planTransitionTimerRef.current = window.setTimeout(() => {
      setPlanTransitionMode("replanning");
      planTransitionTimerRef.current = null;
    }, 220);

    setReplanSubmitting(true);
    try {
      await apiRequest<{ ok: true }>(`/demands/${detail.demand.demand_id}/replan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: note.trim() || null })
      });
      await loadDashboard();
      await loadDemandDetail(detail.demand.demand_id);
      setPlanTransitionMode("idle");
    } catch (error) {
      setPlanTransitionMode("idle");
      window.alert(error instanceof Error ? error.message : t("demand.replan_failed"));
    } finally {
      setReplanSubmitting(false);
    }
  }

  function renderDecisionActions(decision: Decision) {
    // PATH_GRANT_REQUIRED：Approve Once / Approve & Remember / Reject / Cancel —— 不依赖 options
    if (decision.reason_code === "PATH_GRANT_REQUIRED") {
      const submitting = decisionSubmitting === decision.decision_id;
      return [
        <button
          key={`${decision.decision_id}-approve-once`}
          type="button"
          className="primary"
          disabled={submitting}
          onClick={() => void respondToDecision(decision.decision_id, "Approve" as DecisionAction, { remember: false })}
        >
          {submitting ? t("decision_action.sending") : t("decision_action.approve_once")}
        </button>,
        <button
          key={`${decision.decision_id}-approve-remember`}
          type="button"
          className="primary"
          disabled={submitting}
          onClick={() => void respondToDecision(decision.decision_id, "Approve" as DecisionAction, { remember: true })}
        >
          {submitting ? t("decision_action.sending") : t("decision_action.approve_remember")}
        </button>,
        <button
          key={`${decision.decision_id}-reject`}
          type="button"
          className="ghost-button danger-button"
          disabled={submitting}
          onClick={() => void respondToDecision(decision.decision_id, "Reject" as DecisionAction)}
        >
          {submitting ? t("decision_action.sending") : t("decision_action.reject")}
        </button>
        // PATH_GRANT 决策原本有 "Cancel Demand" 按钮（DecisionAction.CANCEL_DEMAND）—— 前端按
        // review #6 要求不再展示。后端 API 仍接受 CancelDemand action，需要时可通过其它途径触发。
      ];
    }

    // 决策卡只暴露 Approve / Reject / ProvideInfo(Reply) 三个动作。
    // Pause/Stop/CancelDemand 等控制动作不在决策卡里 —— 它们属于 demand 级控制（hero 区按钮）。
    // 用正向白名单而非黑名单，确保未来后端即使在 options 里塞了别的动作，卡片也保持干净。
    const DECISION_CARD_ACTIONS = ["Approve", "Reject", "ProvideInfo"];
    const actions = ((decision.options?.length ? decision.options : ["ProvideInfo"]) as DecisionAction[])
      .filter((action) => DECISION_CARD_ACTIONS.includes(action));
    return actions.map((action) => {
      const needsNote = decisionActionNeedsNote(action);
      const disabled = decisionSubmitting === decision.decision_id || (needsNote && !decisionNoteFor(decision.decision_id).trim());
      return (
        <button
          key={`${decision.decision_id}-${action}`}
          type="button"
          className={decisionActionClass(action)}
          disabled={disabled}
          onClick={() => void respondToDecision(decision.decision_id, action)}
        >
          {decisionSubmitting === decision.decision_id ? t("decision_action.sending") : decisionActionLabel(action, decision.reason_code)}
        </button>
      );
    });
  }

  function updateModel(
    role: keyof Settings["models"],
    field: keyof ModelConfig,
    value: string | boolean
  ) {
    setSettingsDraft((current) => ({
      ...current,
      models: {
        ...current.models,
        [role]: {
          ...current.models[role],
          [field]: value
        }
      }
    }));
    setSettingsDirty(true);
    setSettingsStatus("");
  }

  function openCreateDemandPanel() {
    // 记住当前在哪个 demand 详情（如果有），关闭弹窗时要回到这个 demand 而不是 board。
    previousActiveDemandIdRef.current = activeDemandId;
    // 关键：不调 invalidateDemandView 整段。如果清了 activeDemandId + detail，关闭弹窗时
    // 就得重 fetch 一次 demand 详情，用户感觉是"页面刷新了一遍"。
    // 这里只重置和创建新 demand 直接相关的状态（composer 输入 + create-session 防串号），
    // detail / activeDemandId / conversation 都原样保留，关闭弹窗直接零成本回切。
    createSessionRef.current += 1;
    setCreateSubmitting(false);
    setNewDemand("");
    setTab("Dashboard");
    setDashboardView("create");
  }

  /**
   * 永久删除 demand（连带它的 subgoals / executions / decisions / memory / events 一起清）。
   * 用于 sidebar × 按钮：用户的本意是"清理掉这条历史记录"，不是把进行中的任务标 CANCELLED。
   * 后端 DELETE /api/demands/:id 已经实现连级删除。
   */
  async function deleteDemand(demandId: string, displayName: string) {
    if (!window.confirm(t("demand.delete_confirm", { name: displayName }))) {
      return;
    }
    setControlSubmittingId(demandId);
    try {
      await apiRequest<void>(`/demands/${demandId}`, { method: "DELETE" });
      setDemands((current) => current.filter((d) => d.demand_id !== demandId));
      // 如果当前正在看的就是这个 demand，回 board
      if (activeDemandId === demandId) {
        returnToBoard();
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("demand.delete_failed"));
    } finally {
      setControlSubmittingId(null);
    }
  }

  function returnToBoard() {
    invalidateDemandView();
    previousActiveDemandIdRef.current = null;
    setDashboardView("board");
    setSelectedSubgoalDialog(null);
  }

  /**
   * 关闭 Create Demand 弹窗的"软关闭"行为 —— 从哪来回哪去：
   * - 入弹窗前如果在某 demand 详情页（previousActiveDemandIdRef 有值）→ 仅切回 detail 视图。
   *   activeDemandId / detail 都没被 invalidate 过，内存里仍是原来的 demand，UI 秒回，
   *   不会触发 detail-loading 骨架"刷新一遍"。
   * - 入弹窗前在 board → 回 board。
   */
  function closeCreateModal() {
    setSelectedSubgoalDialog(null);
    setCreateModalExpanded(false);
    const prevId = previousActiveDemandIdRef.current;
    previousActiveDemandIdRef.current = null;
    if (prevId) {
      setDashboardView("detail");
    } else {
      setDashboardView("board");
    }
  }

  const showSidebar = tab === "Dashboard" && dashboardView !== "board";
  const showCreateModal = tab === "Dashboard" && dashboardView === "create";
  const latestPlan = detail?.demand.metadata?.latest_plan;
  const runtimeSession = detail?.demand.metadata?.runtime_session;
  const demandSummary = latestPlan?.high_level_summary?.mission_state_summary;
  const planOutline = latestPlan?.overall_plan_outline ?? [];
  const boardDemands = demands.slice(0, 12);
  const boardItemKeys = [...boardDemands.map((item) => item.demand_id), "__create_demand__"];
  const boardDemandIdsKey = boardItemKeys.join("|");
  const conversationHistory = [
    ...(detail?.demand.metadata?.conversation_history ?? []),
    ...conversationPending
  ];
  const globalBusyLabel = replySubmitting
    ? t("busy.llm_replying")
    : createSubmitting
      ? t("busy.creating_demand")
      : detailLoading
        ? t("busy.loading_demand")
        : settingsSaving
          ? t("busy.saving_settings")
          : decisionSubmitting
            ? t("busy.submitting_decision")
            : controlSubmittingId
              ? t("busy.sending_control")
              : workerSubmitting
                ? t("busy.registering_worker")
                : dashboardLoading
                  ? t("busy.syncing")
                  : "";

  const alignmentInProgress = Boolean(detail && demandNeedsClarification(detail.demand));
  const planIsTransitioning = planTransitionMode === "replanning";
  const planIsExiting = planTransitionMode === "exiting";
  const planIsGenerating = Boolean(
    planIsTransitioning || (
    detail &&
    !alignmentInProgress &&
    detail.demand.state !== "COMPLETED" &&
    !["FAILED", "BLOCKED", "CANCELLED"].includes(detail.demand.state) &&
    planOutline.length === 0 &&
    detail.subgoals.length === 0
  ));
  const selectedDialogSubgoal = selectedSubgoalDialog
    ? detail?.subgoals.find((subgoal) => subgoal.subgoal_id === selectedSubgoalDialog.subgoalId) ?? null
    : null;
  const selectedDialogExecution = selectedDialogSubgoal
    ? executionBySubgoalId.get(selectedDialogSubgoal.subgoal_id) ?? null
    : null;
  const selectedDialogDecision = selectedDialogSubgoal
    ? latestDecisionBySubgoalId.get(selectedDialogSubgoal.subgoal_id) ?? null
    : null;
  const selectedDialogWorkerResult = selectedDialogExecution
    ? latestWorkerResultByExecutionId.get(selectedDialogExecution.execution_id) ?? null
    : null;
  const selectedDecisionConversation = selectedDialogDecision?.metadata?.conversation_history ?? [];

  function updateRuntime(field: keyof Settings["runtime"], value: number) {
    setSettingsDraft((current) => ({
      ...current,
      runtime: {
        ...current.runtime,
        [field]: value
      }
    }));
    setSettingsDirty(true);
    setSettingsStatus("");
  }

  function updateWorkspaceRoot(value: string) {
    setSettingsDraft((current) => ({
      ...current,
      workspace_root: value
    }));
    setSettingsDirty(true);
    setSettingsStatus("");
  }

  // Workspace Grants 管理：永久授权清单。下面这些路径让 worker 免询问直接读写；
  // 增删后跟 LLM 配置一起在点 Save Settings 时落盘。
  function addWorkspaceGrant(rawPath: string) {
    const path = rawPath.trim().replace(/\/+$/, "");
    if (!path || !path.startsWith("/")) {
      window.alert(t("settings.general.grants.invalid"));
      return;
    }
    setSettingsDraft((current) => {
      const existing = Array.isArray(current.workspace_grants) ? current.workspace_grants : [];
      if (existing.some((g) => g.path === path)) {
        return current; // 已存在不重复加
      }
      return {
        ...current,
        workspace_grants: [...existing, { path, granted_at: new Date().toISOString() }]
      };
    });
    setSettingsDirty(true);
    setSettingsStatus("");
  }

  function removeWorkspaceGrant(path: string) {
    setSettingsDraft((current) => {
      const existing = Array.isArray(current.workspace_grants) ? current.workspace_grants : [];
      return {
        ...current,
        workspace_grants: existing.filter((g) => g.path !== path)
      };
    });
    setSettingsDirty(true);
    setSettingsStatus("");
  }

  useLayoutEffect(() => {
    if (dashboardView !== "board") {
      previousBoardRects.current = new Map();
      return;
    }

    const nextRects = new Map<string, DOMRect>();
    boardItemKeys.forEach((itemKey) => {
      const element = boardCardRefs.current[itemKey];
      if (element) {
        nextRects.set(itemKey, element.getBoundingClientRect());
      }
    });

    nextRects.forEach((nextRect, demandId) => {
      const prevRect = previousBoardRects.current.get(demandId);
      const element = boardCardRefs.current[demandId];
      if (!prevRect || !element) {
        return;
      }

      const deltaX = prevRect.left - nextRect.left;
      const deltaY = prevRect.top - nextRect.top;
      if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) {
        return;
      }

      const animatedElement = element as HTMLElement & {
        __boardReflowAnimation?: Animation;
      };

      animatedElement.__boardReflowAnimation?.cancel();
      element.style.willChange = "transform";

      const animation = element.animate(
        [
          { transform: `translate(${deltaX}px, ${deltaY}px)` },
          { transform: "translate(0, 0)" }
        ],
        {
          duration: 560,
          easing: "cubic-bezier(0.16, 1, 0.3, 1)",
          fill: "both"
        }
      );

      animatedElement.__boardReflowAnimation = animation;

      const clearAnimation = () => {
        if (animatedElement.__boardReflowAnimation === animation) {
          animatedElement.__boardReflowAnimation = undefined;
        }
        element.style.willChange = "";
      };

      animation.addEventListener("finish", clearAnimation, { once: true });
      animation.addEventListener("cancel", clearAnimation, { once: true });
    });

    previousBoardRects.current = nextRects;
  }, [dashboardView, boardDemandIdsKey]);

  useEffect(() => {
    if (!detail || planOutline.length === 0) {
      setExpandedPlanItemId(null);
      return;
    }

    setExpandedPlanItemId((current) => (
      current && planOutline.some((item) => item.plan_item_id === current)
        ? current
        : null
    ));
  }, [detail?.demand.demand_id, latestPlan?.planning_round, planOutline.length]);

  useEffect(() => {
    void loadDashboard({ silent: true });

    const socket = createNodiktSocket((data) => {
      if (data.type === "workers") {
        setWorkers(data.payload);
      }
      if (data.type === "demand_view" && activeDemandId && data.payload) {
        const payload = data.payload;
        if (payload.demand.demand_id === activeDemandId && createSessionRef.current >= 0) {
          setDetail(payload);
        }
      }
      if (data.type === "event") {
        void loadDashboard({ silent: true });
      }
    });
    return () => socket.close();
  }, [activeDemandId, settingsDirty]);

  useEffect(() => {
    if (!conversationEndRef.current) {
      return;
    }

    conversationEndRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeDemandId, conversationHistory.length, assistantTyping, replySubmitting]);

  useEffect(() => () => {
    if (subgoalDialogCloseTimerRef.current) {
      window.clearTimeout(subgoalDialogCloseTimerRef.current);
    }
    if (planTransitionTimerRef.current) {
      window.clearTimeout(planTransitionTimerRef.current);
    }
  }, []);

  return (
    <div className="shell">
      <div className="splash-screen" aria-hidden="true">
        <div className="splash-logo">NODIKT</div>
      </div>
      <div className="noise-overlay" />
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />
      <div className="aurora aurora-a" />
      <div className="aurora aurora-b" />
      <div className="aurora aurora-c" />
      <div className="aurora aurora-d" />
      <div className="aurora-orb aurora-orb-a" />
      <div className="aurora-orb aurora-orb-b" />
      <div className="aurora-grid" />
      <div className="aurora-noise" />
      <header className="topbar">
        <div className="topbar-left">
          <button
            type="button"
            className="brand brand-button"
            onClick={() => {
              setTab("Dashboard");
              returnToBoard();
              closeWorkerDetail();
            }}
            title={t("brand.copy")}
          >
            <span className="brand-mark" aria-hidden="true" />
            <span className="brand-name">NODIKT</span>
            <span className="brand-copy">{t("brand.copy")}</span>
          </button>
        </div>
        {globalBusyLabel ? <div className="global-busy">{globalBusyLabel}<span className="typing-dots"><span>.</span><span>.</span><span>.</span></span></div> : null}
        <nav className="tabs">
          {(["Dashboard", "Workers", "Settings"] as const).map((item) => {
            const navKey = item === "Dashboard" ? "nav.dashboard" : item === "Workers" ? "nav.workers" : "nav.settings";
            return (
              <button
                key={item}
                className={tab === item ? "tab active" : "tab"}
                onClick={() => {
                  setTab(item);
                  if (item !== "Workers") closeWorkerDetail();
                }}
              >
                {t(navKey)}
                {item === "Dashboard" && actionRequiredCount > 0 ? (
                  <span className="tab-action-badge" aria-label={t("nav.action_badge", { count: actionRequiredCount })}>
                    {actionRequiredCount}
                  </span>
                ) : null}
              </button>
            );
          })}
        </nav>
      </header>

      {actionRequiredCount > 0 && (
        <div className="action-required-bar" role="alert">
          <div className="action-required-bar-left">
            <span className="action-required-pulse" aria-hidden="true" />
            <div className="action-required-copy">
              <strong>{t("action_required.title")}</strong>
              <span>
                {t(actionRequiredCount === 1 ? "action_required.body_one" : "action_required.body_other", { count: actionRequiredCount })}
              </span>
            </div>
          </div>
          <div className="action-required-chips">
            {actionRequiredEntries.slice(0, 6).map((entry) => (
              <button
                key={`action-required-${entry.demand.demand_id}`}
                type="button"
                className={`action-required-chip action-required-chip-${entry.kind}${activeDemandId === entry.demand.demand_id ? " is-active" : ""}`}
                title={entry.hint}
                onClick={() => {
                  setTab("Dashboard");
                  void loadDemandDetail(entry.demand.demand_id);
                }}
              >
                <span className="action-required-chip-tag">{entry.label}</span>
                <span className="action-required-chip-title">{displayDemandTitle(entry.demand)}</span>
              </button>
            ))}
            {actionRequiredEntries.length > 6 ? (
              <span className="action-required-chip action-required-chip-more">
                +{actionRequiredEntries.length - 6} more
              </span>
            ) : null}
          </div>
        </div>
      )}

      <main className={showSidebar ? "layout layout-sidebar" : "layout layout-board"}>
        {tab === "Dashboard" && (
          <>
            {showSidebar && (
            <aside className="sidebar">
              <div className="sidebar-header">
                <div>
                  <h3>{t("sidebar.demands")}</h3>
                  <p className="sidebar-meta">{t("sidebar.demand_counts", { active: activeDemandCount, completed: completedDemandCount })}</p>
                </div>
                <button className="sidebar-plus" onClick={openCreateDemandPanel} title={t("sidebar.new_demand_title")}>
                  +
                </button>
              </div>
              <button className="sidebar-back" onClick={returnToBoard}>
                {t("sidebar.back_to_board")}
              </button>
              {demands.map((demand) => (
                (() => {
                  const indicator = demandProgressIndicator(demand);
                  // Sidebar 每条 demand 永远显示 × ——包括 COMPLETED/FAILED/CANCELLED，
                  // 因为用户原话"点击就是删除 demand"，恰恰最想清理的是这些历史 demand。
                  // 点击调 DELETE /demands/:id 永久删除（含连级清 subgoals/executions/...）。
                  // 外层用 div 而非 button —— HTML 不允许 button 嵌 button。
                  return (
                    <div
                      key={demand.demand_id}
                      role="button"
                      tabIndex={0}
                      className={detail?.demand.demand_id === demand.demand_id ? "demand-link active" : "demand-link"}
                      onClick={() => loadDemandDetail(demand.demand_id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          void loadDemandDetail(demand.demand_id);
                        }
                      }}
                    >
                      <span className="demand-link-copy">
                        <strong>{displayDemandTitle(demand)}</strong>
                        <small className="demand-link-meta">
                          <span>{demand.current_phase}</span>
                          {/* Claude-style 相对时间 chip —— 当 sidebar 里 demand 多/标题相近时，
                              用"7m / 1h / 1d"做二次区分。绝对时间作为 title hover 兜底，
                              复用顶部已有的 formatRelativeShort + time.* i18n（en/zh 都已定义）。 */}
                          <span
                            className="sidebar-demand-time"
                            title={demand.updated_at ?? demand.created_at}
                          >
                            {formatRelativeShort(demand.updated_at ?? demand.created_at, Date.now(), t)}
                          </span>
                        </small>
                      </span>
                      <span
                        className={`demand-progress demand-progress-${indicator.tone}${indicator.done ? " is-done" : ""}`}
                        style={{ "--progress": `${indicator.progress}%` } as CSSProperties}
                        aria-label={`${demand.state} progress`}
                      >
                        {indicator.done ? <span className="demand-progress-check">✓</span> : null}
                      </span>
                      <button
                        type="button"
                        className="demand-link-delete"
                        title={t("sidebar.delete_title")}
                        disabled={controlSubmittingId === demand.demand_id}
                        onClick={(event) => {
                          event.stopPropagation();
                          void deleteDemand(demand.demand_id, displayDemandTitle(demand));
                        }}
                      >
                        {controlSubmittingId === demand.demand_id ? "…" : "×"}
                      </button>
                    </div>
                  );
                })()
              ))}
            </aside>
            )}

            <section className={dashboardView === "board" ? "content board-content" : "content detail-content"}>
              {dashboardView === "board" && (
                <div className="board-shell">
                  <div className="board-splash" aria-hidden="true">
                    <span>Nodikt</span>
                  </div>
                  <div className="demand-board">
                    {boardDemands.map((demand) => (
                      <article
                        key={demand.demand_id}
                        ref={(element) => {
                          boardCardRefs.current[demand.demand_id] = element;
                        }}
                        className={`demand-board-card${boardDismissingId === demand.demand_id ? " is-dismissing" : ""}`}
                      >
                        <div className="demand-board-top">
                          <span className={`dashboard-lamp dashboard-lamp-${demandLampTone(demand)}`} />
                          <div className="demand-board-actions">
                            <span className="demand-board-phase">{demand.current_phase}</span>
	                            <button
	                              type="button"
	                              className="board-delete"
	                              title={t("sidebar.delete_title")}
	                              disabled={controlSubmittingId === demand.demand_id}
	                              onClick={(event) => {
	                                event.stopPropagation();
	                                // Dashboard board 上的 × 改成跟 sidebar 一致的真删除（DELETE /demands/:id）。
	                                // 之前是 controlDemand("cancel")，把 demand 标 CANCELLED 但保留在列表里 ——
	                                // 用户反馈两边应统一为"删除"语义，CANCELLED 历史也想能清掉。
	                                // 不再设 dismissing 动画 —— deleteDemand 内的 confirm 会先弹出，
	                                // 用户取消时 dismissing class 会让卡片误带过渡动画状态；
	                                // 现在直接靠 deleteDemand 的 setDemands 自然移除节点。
	                                void deleteDemand(demand.demand_id, displayDemandTitle(demand));
	                              }}
	                            >
	                              {controlSubmittingId === demand.demand_id ? "…" : "×"}
	                            </button>
                          </div>
                        </div>
                        <button
                          type="button"
                          className="demand-board-card-main"
                          onClick={() => loadDemandDetail(demand.demand_id)}
                        >
                          <strong>{displayDemandTitle(demand)}</strong>
                          <div className="dashboard-card-meta">
                            <span className="dashboard-card-label">{t("dashboard.card.subgoal")}</span>
                            <p className="dashboard-card-subgoal">{demand.dashboard_summary?.current_subgoal_title ?? t("dashboard.waiting_subgoal")}</p>
                          </div>
                          <div className="dashboard-card-footer">
                            <small>{t((demand.dashboard_summary?.worker_count ?? 0) === 1 ? "dashboard.worker_count_one" : "dashboard.worker_count_other", { count: demand.dashboard_summary?.worker_count ?? 0 })}</small>
                            {/* E-T3：看板卡片也加上相对时间 chip（sidebar 已在 E-T2 加过）。
                                绝对时间挂在 title 上 hover 兜底；复用 formatRelativeShort + time.* i18n。 */}
                            <small className="dashboard-card-time" title={demand.updated_at ?? demand.created_at}>
                              {formatRelativeShort(demand.updated_at ?? demand.created_at, Date.now(), t)}
                            </small>
                            <small>{demand.state}</small>
                          </div>
                        </button>
                      </article>
                    ))}
                    <button
                      ref={(element) => {
                        boardCardRefs.current["__create_demand__"] = element;
                      }}
                      className="demand-board-card demand-board-card-add"
                      onClick={openCreateDemandPanel}
                    >
                      <span className="demand-board-add-mark">+</span>
                      <strong>{t("dashboard.card.create.title")}</strong>
                      <p>{t("dashboard.card.create.desc")}</p>
                    </button>
                  </div>
                </div>
              )}

              {dashboardView === "detail" && (!detail || detail.demand.demand_id !== activeDemandId) && detailLoading && (
                <div className="detail-stack detail-stack-loading">
                  <section className="detail-hero detail-section section-a detail-hero-loading">
                    <div className="detail-hero-copy">
                      <div className="detail-hero-heading">
                        <span className="detail-label">{t("demand.detail.label")}</span>
                        <h1>{t("demand.detail.opening")}</h1>
                      </div>
                      <p className="detail-summary">{t("demand.detail.opening_desc")}</p>
                    </div>
                  </section>
                  <div className="detail-grid detail-grid-plan-only">
                    <section className="panel detail-section section-b plan-panel plan-panel-loading">
                      <div className="panel-heading">
                        <div>
                          <p className="eyebrow">{t("planner.eyebrow")}</p>
                          <h2>{t("planner.title")}</h2>
                        </div>
                        <span className="status-chip">{t("planner.loading_chip")}</span>
                      </div>
                      <div className="plan-loading-state">
                        <div className="typing-dots"><span>.</span><span>.</span><span>.</span></div>
                        <p>{t("planner.preparing")}</p>
                        <div className="plan-skeleton-list">
                          <div className="plan-skeleton-card" />
                          <div className="plan-skeleton-card" />
                          <div className="plan-skeleton-card" />
                        </div>
                      </div>
                    </section>
                  </div>
                </div>
              )}

              {dashboardView === "detail" && detail && detail.demand.demand_id === activeDemandId && (
                <div className="detail-stack">
                  <section className="detail-hero detail-section section-a">
                    <div className="detail-hero-copy">
                      <div className="detail-hero-heading">
                        <span className="detail-label">{t("demand.detail.label")}</span>
                        <h1>{displayDemandTitle(detail.demand)}</h1>
                      </div>
                      <p className="detail-summary">{detail.demand.clarified_demand ?? detail.demand.initial_input}</p>
                    </div>
                    <div className="detail-hero-side">
                      <div className="detail-mini-stats">
                        <div className={`detail-mini-stat detail-mini-stat-${stateTone(detail.demand.state)}`}>
                          <span>{t("demand.detail.status")}</span>
                          <strong>{detail.demand.state}</strong>
                        </div>
                        <div className="detail-mini-stat">
                          <span>{t("demand.detail.phase")}</span>
                          <strong>{detail.demand.current_phase}</strong>
                        </div>
                        <div className="detail-mini-stat">
                          <span>{t("demand.detail.running")}</span>
                          <strong>{runningExecutionCount}</strong>
                        </div>
                        <div className="detail-mini-stat">
                          <span>{t("demand.detail.decisions")}</span>
                          <strong>{openDecisionCount}</strong>
                        </div>
	                      </div>
	                      {demandBrainError(detail.demand) ? (
	                        <div className="demand-brain-error" role="alert">
	                          <span className="pill pill-danger">{t("demand.detail.brain_error_label")}</span>
	                          <p className="demand-brain-error-msg">{demandBrainError(detail.demand)?.message}</p>
	                          <small className="demand-brain-error-hint">{t("demand.detail.brain_error_retry")}</small>
	                        </div>
	                      ) : null}
	                      <div className="detail-hero-actions">
	                        {detail.demand.state === "PAUSED" ? (
	                          <button
	                            type="button"
	                            className="primary"
	                            disabled={controlSubmittingId === detail.demand.demand_id}
	                            onClick={() => void controlDemand(detail.demand.demand_id, "resume", t("demand.detail.resume_note"))}
	                          >
	                            {t("demand.detail.resume")}
	                          </button>
	                        ) : (
	                          <button
	                            type="button"
	                            className="ghost-button"
	                            disabled={controlSubmittingId === detail.demand.demand_id || ["COMPLETED", "FAILED", "CANCELLED"].includes(detail.demand.state)}
	                            onClick={() => void controlDemand(detail.demand.demand_id, "pause", t("demand.detail.pause_note"))}
	                          >
	                            {t("demand.detail.pause")}
	                          </button>
	                        )}
	                        <button
	                          type="button"
	                          className="ghost-button interrupt-button"
	                          title={t("demand.detail.interrupt_title")}
	                          disabled={
	                            controlSubmittingId === detail.demand.demand_id ||
	                            runningExecutionCount === 0 ||
	                            ["COMPLETED", "FAILED", "CANCELLED", "PAUSED"].includes(detail.demand.state)
	                          }
	                          onClick={() => {
	                            const note = window.prompt(
	                              t(runningExecutionCount === 1 ? "demand.detail.interrupt_prompt_one" : "demand.detail.interrupt_prompt_other", { count: runningExecutionCount }),
	                              ""
	                            );
	                            if (note === null) {
	                              return;
	                            }
	                            void controlDemand(detail.demand.demand_id, "interrupt", note.trim() || t("demand.detail.interrupt_default_note"));
	                          }}
	                        >
	                          {controlSubmittingId === detail.demand.demand_id
	                            ? t("common.sending")
	                            : (runningExecutionCount > 0
	                                ? t("demand.detail.interrupt_with_count", { count: runningExecutionCount })
	                                : t("demand.detail.interrupt"))}
	                        </button>
	                        {/* 详情页头部原 "Cancel Demand" 按钮按 review #6 隐藏（后端 controlDemand cancel API 仍保留）。 */}
	                        <button
	                          type="button"
	                          className="ghost-button danger-button"
	                          disabled={
	                            controlSubmittingId === detail.demand.demand_id ||
	                            ["COMPLETED", "FAILED", "CANCELLED"].includes(detail.demand.state)
	                          }
	                          onClick={() => {
	                            if (!window.confirm(t("demand.detail.cancel_confirm"))) {
	                              return;
	                            }
	                            void controlDemand(
	                              detail.demand.demand_id,
	                              "cancel",
	                              t("demand.detail.cancel_note"),
	                              { returnToBoardAfterCancel: true }
	                            );
	                          }}
	                        >
	                          {controlSubmittingId === detail.demand.demand_id ? t("common.sending") : t("demand.detail.cancel_task")}
	                        </button>
	                      </div>
	                      {detail.demand.state === "PAUSED" ? (
	                        <div className="paused-instruction-box">
	                          <label className="field">
	                            <span>{t("demand.detail.paused_instruction_label")}</span>
	                            <textarea
	                              value={pausedInstruction}
	                              onChange={(event) => setPausedInstruction(event.target.value)}
	                              placeholder={t("demand.detail.paused_instruction_placeholder")}
	                            />
	                          </label>
	                          <button
	                            type="button"
	                            className="primary"
	                            disabled={controlSubmittingId === detail.demand.demand_id}
	                            onClick={async () => {
	                              const instruction = pausedInstruction.trim();
	                              await controlDemand(
	                                detail.demand.demand_id,
	                                "resume",
	                                instruction.length > 0 ? instruction : t("demand.detail.resume_note")
	                              );
	                              setPausedInstruction("");
	                            }}
	                          >
	                            {controlSubmittingId === detail.demand.demand_id
	                              ? t("common.sending")
	                              : t("demand.detail.resume_with_instruction")}
	                          </button>
	                        </div>
	                      ) : null}
	                    </div>
	                  </section>

	                  {/* 调试信息折叠组：Backend State Record + Plan Evolution。
	                      Runtime Session 按 review 反馈整体从前端去掉（后端日志里仍记录），
	                      避免给客户看 Phase / Frontier / Checkpoint 这种内部状态机字段。 */}
	                  <details className="debug-fold">
	                    <summary className="debug-fold-summary">
	                      <span className="debug-fold-icon" aria-hidden="true">🛠</span>
	                      <span>{t("debug.title")}</span>
	                      <small className="debug-fold-hint">{t("debug.hint")}</small>
	                    </summary>
	                  <section className="panel detail-section state-record-panel">
	                    <div className="panel-heading">
	                      <div>
	                        <p className="eyebrow">{t("state_record.eyebrow")}</p>
	                        <h2>{t("state_record.title")}</h2>
	                      </div>
	                      <span className="status-chip">{t("state_record.memory_records", { count: detail.memory.length })}</span>
	                    </div>
                      <div className="state-record-grid">
                        <article className="state-record-card">
                          <small>{t("state_record.objective")}</small>
                          <p className="bounded-copy">
                            {detail.demand.operational_objective?.objective
                              ?? detail.demand.clarified_demand
                              ?? detail.demand.initial_input}
                          </p>
                        </article>
                        <article className="state-record-card">
                          <small>{t("state_record.acceptance")}</small>
                          {(
                            detail.demand.operational_objective?.acceptance_criteria?.length
                              ? detail.demand.operational_objective.acceptance_criteria
                              : detail.demand.acceptance_criteria
                          ).length ? (
                            <ul className="compact-list">
                              {(detail.demand.operational_objective?.acceptance_criteria?.length
                                ? detail.demand.operational_objective.acceptance_criteria
                                : detail.demand.acceptance_criteria
                              ).map((item) => <li key={item}>{item}</li>)}
                            </ul>
                          ) : <p className="bounded-copy">{t("state_record.no_acceptance")}</p>}
                        </article>
                        <article className="state-record-card">
                          <small>{t("state_record.constraints")}</small>
                          {(
                            detail.demand.operational_objective?.constraints?.length
                              ? detail.demand.operational_objective.constraints
                              : detail.demand.constraints
                          ).length ? (
                            <ul className="compact-list">
                              {(detail.demand.operational_objective?.constraints?.length
                                ? detail.demand.operational_objective.constraints
                                : detail.demand.constraints
                              ).map((item) => <li key={item}>{item}</li>)}
                            </ul>
                          ) : <p className="bounded-copy">{t("state_record.no_constraints")}</p>}
                        </article>
                        <article className="state-record-card">
                          <small>{t("state_record.memory")}</small>
                          {detail.memory.length ? (
                            <div className="memory-list">
                              {detail.memory.map((item) => (
                                <div key={item.memory_id} className="memory-item">
                                  <span>{item.category}</span>
                                  <p>{item.content}</p>
                                </div>
                              ))}
                            </div>
                          ) : <p className="bounded-copy">{t("state_record.no_memory")}</p>}
                        </article>
                      </div>
	                  </section>

	                  {(() => {
	                    const planningRound = latestPlan?.planning_round ?? 0;
	                    const lessonsSummary = latestPlan?.high_level_summary?.lessons_or_policy_summary?.trim();
	                    const traceSummary = latestPlan?.high_level_summary?.episodic_trace_summary?.trim();
	                    const lessonsMemory = detail.memory.filter((item) => item.category === "lessons_or_policy");
	                    const traceMemory = detail.memory.filter((item) => item.category === "episodic_trace");
	                    const blockerEvents = detail.events
	                      .filter((event) => event.event_type === "WORKER_RESULT_RECEIVED")
	                      .map((event) => (event.payload as WorkerResultEventPayload | undefined)?.worker_result)
	                      .filter((result): result is NonNullable<WorkerResultEventPayload["worker_result"]> => Boolean(result?.blocker_reason?.message))
	                      .slice(-3)
	                      .reverse();
	                    const hasEvolution =
	                      planningRound > 1 ||
	                      Boolean(lessonsSummary) ||
	                      Boolean(traceSummary) ||
	                      lessonsMemory.length > 0 ||
	                      traceMemory.length > 0 ||
	                      blockerEvents.length > 0;
	                    if (!hasEvolution) {
	                      return null;
	                    }
	                    return (
	                      <section className="panel detail-section plan-evolution-panel">
	                        <div className="panel-heading">
	                          <div>
	                            <p className="eyebrow">{t("plan_evolution.eyebrow")}</p>
	                            <h2>{t("plan_evolution.title", { round: Math.max(planningRound, 1) })}</h2>
	                          </div>
	                          <span className={`status-chip ${planningRound > 1 ? "status-chip-info" : ""}`}>
	                            {planningRound > 1 ? t("plan_evolution.rounds_chip", { count: planningRound }) : t("plan_evolution.initial_chip")}
	                          </span>
	                        </div>
	                        <p className="bounded-copy plan-evolution-intro">
	                          {t("plan_evolution.intro")}
	                        </p>
	                        <div className="plan-evolution-grid">
	                          <article className="plan-evolution-card">
	                            <small>{t("plan_evolution.done_label")}</small>
	                            {traceSummary ? (
	                              <p className="bounded-copy">{traceSummary}</p>
	                            ) : traceMemory.length ? (
	                              <ul className="compact-list">
	                                {traceMemory.slice(-4).map((item) => (
	                                  <li key={item.memory_id}>{item.content}</li>
	                                ))}
	                              </ul>
	                            ) : (
	                              <p className="bounded-copy">{t("plan_evolution.no_trace")}</p>
	                            )}
	                          </article>
	                          <article className="plan-evolution-card">
	                            <small>{t("plan_evolution.learned_label")}</small>
	                            {lessonsSummary ? (
	                              <p className="bounded-copy">{lessonsSummary}</p>
	                            ) : lessonsMemory.length ? (
	                              <ul className="compact-list">
	                                {lessonsMemory.slice(-4).map((item) => (
	                                  <li key={item.memory_id}>{item.content}</li>
	                                ))}
	                              </ul>
	                            ) : (
	                              <p className="bounded-copy">{t("plan_evolution.no_lessons")}</p>
	                            )}
	                          </article>
	                          <article className="plan-evolution-card plan-evolution-card-wide">
	                            <small>{t("plan_evolution.feedback_label")}</small>
	                            {blockerEvents.length ? (
	                              <ul className="plan-evolution-feedback">
	                                {blockerEvents.map((result, idx) => (
	                                  <li key={`${result.execution_id}-${idx}`}>
	                                    <span className="pill pill-warning">{result.blocker_reason?.code ?? t("plan_evolution.feedback_default_code")}</span>
	                                    <p className="bounded-copy">{result.blocker_reason?.message}</p>
	                                    {result.suggested_next_step ? (
	                                      <small>{t("plan_evolution.next_step_suggested", { step: result.suggested_next_step })}</small>
	                                    ) : null}
	                                  </li>
	                                ))}
	                              </ul>
	                            ) : (
	                              <p className="bounded-copy">{t("plan_evolution.no_blockers")}</p>
	                            )}
	                          </article>
	                        </div>
	                      </section>
	                    );
	                  })()}
	                  </details>

	                  {openDecisions.length > 0 ? (
	                    <section className="panel detail-section decision-panel">
	                      <div className="panel-heading">
	                        <div>
	                          <p className="eyebrow">{t("decision.eyebrow")}</p>
	                          <h2>{t("decision.title_count", { count: openDecisions.length })}</h2>
	                        </div>
	                        <span className="status-chip status-chip-warning">{t("decision.waiting_on_you")}</span>
	                      </div>
	                      <div className="list-stack">
	                        {openDecisions.map((decision) => (
	                          <article
	                            key={decision.decision_id}
	                            className={`decision-card${
	                              decision.reason_code === "PLAN_REVIEW"
	                                ? " decision-card-plan-review"
	                                : decision.reason_code === "PATH_GRANT_REQUIRED"
	                                  ? " decision-card-path-grant"
	                                  : ""
	                            }`}
	                          >
	                            <div className="decision-modal-head">
	                              <small className={`pill ${
	                                decision.reason_code === "PLAN_REVIEW"
	                                  ? "pill-info"
	                                  : decision.reason_code === "PATH_GRANT_REQUIRED"
	                                    ? "pill-accent"
	                                    : "pill-warning"
	                              }`}>{decisionReasonLabel(decision.reason_code)}</small>
	                              <small>{decision.source ?? t("common.scheduler")}</small>
	                            </div>
	                            <p className="bounded-copy decision-copy">{summarizeDecisionPrompt(decision.prompt)}</p>
	                            <label className="field">
	                              <span>{t("decision.reply_label")}</span>
	                              <textarea
	                                value={decisionNoteFor(decision.decision_id)}
	                                onChange={(event) => updateDecisionNote(decision.decision_id, event.target.value)}
	                                placeholder={t("decision.reply_placeholder")}
	                              />
	                            </label>
	                            <div className="decision-modal-actions">
	                              {renderDecisionActions(decision)}
	                            </div>
	                          </article>
	                        ))}
	                      </div>
	                    </section>
	                  ) : null}

	                  {failedSubgoals.length > 0 ? (
	                    <section className="panel detail-section error-summary-panel">
	                      <div className="panel-heading">
	                        <div>
	                          <p className="eyebrow">{t("error_summary.eyebrow")}</p>
	                          <h2>{t("error_summary.title_count", { count: failedSubgoals.length })}</h2>
	                        </div>
	                      </div>
	                      <div className="list-stack">
	                        {failedSubgoals.map((sg) => {
	                          const exec = executionBySubgoalId.get(sg.subgoal_id) ?? null;
	                          const decision = latestDecisionBySubgoalId.get(sg.subgoal_id) ?? null;
	                          const workerResult = exec
	                            ? latestWorkerResultByExecutionId.get(exec.execution_id) ?? null
	                            : null;
	                          const conversation = decision?.metadata?.conversation_history ?? [];
	                          return (
	                            <article key={sg.subgoal_id} className="decision-card error-summary-item">
	                              <div className="error-summary-head">
	                                <small className="pill pill-danger">{sg.state}</small>
	                                <button
	                                  type="button"
	                                  className="ghost-button error-summary-title"
	                                  onClick={() => openSubgoalDialog(sg.subgoal_id, "failed")}
	                                >
	                                  {sg.title}
	                                </button>
	                              </div>
	                              <pre className="error-summary-detail">
	                                {rawSubgoalIssueText(exec, workerResult, decision)}
	                              </pre>
	                              {conversation.length > 0 ? (
	                                <details className="error-summary-conversation">
	                                  <summary>{t("error_summary.show_conversation")}</summary>
	                                  <div className="suggestion-dialogue">
	                                    {conversation.map((message, index) => (
	                                      <div
	                                        key={`${message.created_at}-${index}`}
	                                        className={`conversation-turn ${message.role === "assistant" ? "assistant" : "user"} suggestion-turn`}
	                                      >
	                                        <small>{message.role === "assistant" ? t("demand.detail.assistant") : t("common.you")}</small>
	                                        {message.role === "assistant" ? (
	                                          <p className="suggestion-message">{summarizeDecisionPrompt(message.content)}</p>
	                                        ) : (
	                                          <p>{message.content}</p>
	                                        )}
	                                      </div>
	                                    ))}
	                                  </div>
	                                </details>
	                              ) : null}
	                            </article>
	                          );
	                        })}
	                      </div>
	                    </section>
	                  ) : null}

	                  <div className="detail-grid detail-grid-plan-only">
                    <section className="panel detail-section section-b plan-panel">
                      <div className="panel-heading">
                        <div>
                          <p className="eyebrow">{t("planner.eyebrow")}</p>
                          <h2>
                            {t("planner.title")}
                            {(latestPlan?.planning_round ?? 0) > 1 ? (
                              <span className="plan-round-badge">v{latestPlan?.planning_round}</span>
                            ) : null}
                          </h2>
                          <small className="plan-subnote">{t("planner.subnote")}</small>
                        </div>
                        <div className="plan-heading-actions">
                          {/* Replan 按钮按 review 反馈从前端去掉。后端 requestReplan API 仍保留，
                              通过 DECISION_RESPONSE_RECEIVED(action=ProvideInfo, note 含 "replan") 触发。 */}
                          <span className="status-chip">{t("planner.subgoals_chip", { count: detail.subgoals.length })}</span>
                        </div>
                      </div>
                      <div className={`plan-scroll${planIsExiting ? " is-replan-exiting" : ""}${planIsTransitioning ? " is-replanning" : ""}`}>
                        {alignmentInProgress ? (
                          demandHasBrainError(detail.demand) ? (
                            // —— 故障框架：brain LLM 坏了，用户不该被问"澄清"，而该去 Settings 改配置再 Retry。
                            <div className="plan-waiting-state plan-waiting-state-fault">
                              <div className="plan-waiting-head">
                                <div>
                                  <p className="eyebrow">{t("fault.eyebrow")}</p>
                                  <h3>{t("fault.title")}</h3>
                                </div>
                                <span className="status-chip status-chip-danger">{t("fault.chip")}</span>
                              </div>
                              <p className="bounded-copy">{t("fault.copy")}</p>
                              {/* conversation 历史保留只读，让用户看到自己的原始输入 + 系统故障声明 */}
                              <div className="conversation-scroll modal-conversation-scroll detail-conversation-scroll">
                                {conversationHistory.map((message, index) => (
                                  <div key={`${message.created_at}-${index}`} className={`conversation-turn ${message.role === "assistant" ? "assistant" : "user"}`}>
                                    <small>{message.role === "assistant" ? t("common.assistant") : t("common.you")}</small>
                                    <p>{message.content}</p>
                                  </div>
                                ))}
                                <div ref={conversationEndRef} />
                              </div>
                              <div className="modal-actions">
                                <button
                                  className="primary"
                                  disabled={replySubmitting}
                                  onClick={() => sendClarificationReplyText("retry")}
                                >
                                  {replySubmitting ? t("common.sending") : t("fault.retry")}
                                </button>
                              </div>
                            </div>
                          ) : (
                          <div className="plan-waiting-state">
                            <div className="plan-waiting-head">
                              <div>
                                <p className="eyebrow">{t("alignment.eyebrow")}</p>
                                <h3>{t("alignment.title")}</h3>
                              </div>
                              <span className="status-chip status-chip-warning">{t("alignment.chip")}</span>
                            </div>
                            <p className="bounded-copy">
                              {t("alignment.copy")}
                            </p>
                            <div className="conversation-scroll modal-conversation-scroll detail-conversation-scroll">
                              {conversationHistory.map((message, index) => {
                                const isReconFindings = message.role === "assistant" && message.content.startsWith("[Recon findings]");
                                const displayContent = isReconFindings
                                  ? message.content.replace(/^\[Recon findings\]\s*/, "")
                                  : message.content;
                                const label = isReconFindings
                                  ? t("alignment.recon_findings")
                                  : message.role === "assistant" ? t("common.assistant") : t("common.you");
                                const cls = `conversation-turn ${message.role === "assistant" ? "assistant" : "user"}${isReconFindings ? " conversation-turn-recon-findings" : ""}`;
                                return (
                                  <div key={`${message.created_at}-${index}`} className={cls}>
                                    <small>{label}</small>
                                    <p>{displayContent}</p>
                                  </div>
                                );
                              })}
                              {assistantTyping ? (
                                <div className="conversation-turn assistant conversation-turn-typing">
                                  <small>{t("common.assistant")}</small>
                                  <div className="typing-dots"><span>.</span><span>.</span><span>.</span></div>
                                </div>
                              ) : null}
                              <div ref={conversationEndRef} />
                            </div>
                            {detail.demand.metadata?.clarification_question ? (
                              <>
                                <label className="field">
                                  <span>{t("alignment.reply_label")}</span>
                                  <textarea
                                    value={clarificationReply}
                                    onChange={(event) => setClarificationReply(event.target.value)}
                                    placeholder={t("alignment.reply_placeholder")}
                                  />
                                </label>
                                <div className="modal-actions">
                                  <button className="primary" disabled={replySubmitting || !clarificationReply.trim()} onClick={sendClarificationReply}>
                                    {replySubmitting ? t("common.sending") : t("alignment.send_reply")}
                                  </button>
                                </div>
                              </>
                            ) : (
                              <div className="plan-loading-inline">
                                <div className="typing-dots"><span>.</span><span>.</span><span>.</span></div>
                                <p>{t("alignment.waiting_next")}</p>
                              </div>
                            )}
                          </div>
                          )
                        ) : planIsGenerating ? (
                          <div className="plan-loading-state plan-loading-state-replan">
                            <div className="plan-waiting-head">
                              <div>
                                <p className="eyebrow">{t("planning.eyebrow")}</p>
                                <h3>{planIsTransitioning ? t("planning.replanning") : t("planning.generating")}</h3>
                              </div>
                              <span className="status-chip status-chip-info">{t("planning.chip")}</span>
                            </div>
                            <p className="bounded-copy">
                              {planIsTransitioning
                                ? t("planning.replan_copy")
                                : t("planning.gen_copy")}
                            </p>
                            <div className="plan-loading-inline plan-loading-inline-pixel">
                              <div className="pixel-loader" aria-hidden="true">
                                <span className="pixel-loader-cell" />
                                <span className="pixel-loader-cell" />
                                <span className="pixel-loader-cell" />
                                <span className="pixel-loader-cell" />
                                <span className="pixel-loader-cell" />
                                <span className="pixel-loader-cell" />
                                <span className="pixel-loader-cell" />
                                <span className="pixel-loader-cell" />
                                <span className="pixel-loader-cell" />
                              </div>
                              <p>{t("planning.thinking")}</p>
                            </div>
                          </div>
                        ) : (
                          <>
                        {demandSummary ? <p className="plan-summary bounded-copy">{demandSummary}</p> : null}
                        {planOutline.length ? (
                          <div className="plan-list plan-list-collapsible">
                            {planOutline.map((item, index) => {
                              const linkedSubgoals = detail.subgoals.filter((subgoal) => {
                                const mappedIds = item.frontier_subgoal_ids ?? [];
                                if (mappedIds.length > 0) {
                                  return mappedIds.includes(subgoal.subgoal_id);
                                }
                                return index === 0;
                              });
                              const isExpanded = expandedPlanItemId === item.plan_item_id;

                              return (
                                <article
                                  key={item.plan_item_id}
                                  className={`plan-card plan-card-collapsible${isExpanded ? " is-expanded" : ""}`}
                                >
                                  <button
                                    type="button"
                                    className="plan-toggle"
                                    onClick={() => setExpandedPlanItemId(isExpanded ? null : item.plan_item_id)}
                                    aria-expanded={isExpanded}
                                  >
                                    <div className="plan-toggle-main">
                                      <div className="plan-card-top">
                                        <span className="plan-index">{index + 1}</span>
                                        <small className={`pill pill-${item.execution_mode === "parallel" ? "info" : "neutral"}`}>
                                          {item.execution_mode}
                                        </small>
                                      </div>
                                      <div className="plan-card-copy">
                                        <strong>{item.title}</strong>
                                        <p>{item.objective}</p>
                                      </div>
                                    </div>
                                    <div className="plan-toggle-side">
                                      <span className="status-chip">{linkedSubgoals.length} subgoals</span>
                                      <span className={`plan-toggle-chevron${isExpanded ? " is-expanded" : ""}`}>⌄</span>
                                    </div>
                                  </button>
                                  {isExpanded ? (
                                    <div className="plan-card-expanded">
                                      <p className="plan-card-rationale bounded-copy">{item.rationale}</p>
                                      <div className="list-stack plan-subgoal-stack">
                                        {linkedSubgoals.length > 0 ? linkedSubgoals.map((subgoal) => {
                                          const execution = executionBySubgoalId.get(subgoal.subgoal_id);
                                          const linkedDecision = latestDecisionBySubgoalId.get(subgoal.subgoal_id);
                                          const assignedWorkerId = assignedWorkerBySubgoalId.get(subgoal.subgoal_id);
                                          const assignedWorkerLabel = assignedWorkerId
                                            ? (workerNameById.get(assignedWorkerId) ?? assignedWorkerId)
                                            : t("common.unassigned");
                                          const stage = subgoalStage(subgoal.state, execution, linkedDecision);
                                          const inspectable = hasInspectableIssue(stage, linkedDecision);

                                          return (
                                            <div key={subgoal.subgoal_id} className={`plan-subgoal-card plan-subgoal-grid${subgoal.kind === "recon" ? " plan-subgoal-card-recon" : ""}`}>
                                              <div className="subgoal-zone subgoal-zone-main">
                                                <strong>
                                                  {subgoal.title}
                                                  {subgoal.kind === "recon" ? (
                                                    <span className="subgoal-kind-badge subgoal-kind-recon" title={t("subgoal.recon_badge_title")}>RECON</span>
                                                  ) : null}
                                                </strong>
                                                <p>{subgoal.objective}</p>
                                                {linkedDecision ? (
                                                  <small className="subgoal-inline-note">
                                                    {rawSubgoalIssueText(execution, latestWorkerResultByExecutionId.get(execution?.execution_id ?? ""), linkedDecision).split("\n")[0]}
                                                  </small>
                                                ) : null}
                                              </div>
                                              <div className="subgoal-zone subgoal-zone-worker">
                                                <small>{t("subgoal.assigned_worker")}</small>
                                                <span className={`subgoal-assignment-badge${assignedWorkerId ? "" : " is-unassigned"}`}>
                                                  {assignedWorkerLabel}
                                                </span>
                                              </div>
                                                <div className="subgoal-zone subgoal-zone-status">
                                                  <button
                                                    type="button"
                                                    className={`subgoal-status-display subgoal-status-${stage}${inspectable ? " is-clickable" : ""}`}
                                                    disabled={!inspectable}
                                                    onClick={() => {
                                                      if (!inspectable) {
                                                        return;
                                                      }
                                                      openSubgoalDialog(
                                                        subgoal.subgoal_id,
                                                        stage === "success" ? "success" : stage === "failed" ? "failed" : "issue"
                                                      );
                                                    }}
                                                  >
                                                    {stageLabel(stage, linkedDecision)}
                                                  </button>
                                                  {stage === "running" && execution ? (
                                                    <button
                                                      type="button"
                                                      className="subgoal-interrupt-button"
                                                      title={t("subgoal.interrupt_title")}
                                                      disabled={controlSubmittingId === execution.execution_id}
                                                      onClick={(event) => {
                                                        event.stopPropagation();
                                                        if (!window.confirm(t("subgoal.interrupt_confirm", { title: subgoal.title }))) {
                                                          return;
                                                        }
                                                        void interruptExecution(execution.execution_id, detail.demand.demand_id, t("subgoal.interrupt_note", { title: subgoal.title }));
                                                      }}
                                                    >
                                                      {controlSubmittingId === execution.execution_id ? "..." : t("subgoal.interrupt_label")}
                                                    </button>
                                                  ) : null}
                                                </div>
                                              </div>
                                          );
                                        }) : <p className="bounded-copy">{t("subgoal.no_frontier")}</p>}
                                      </div>
                                    </div>
                                  ) : null}
                                </article>
                              );
                            })}
                          </div>
                        ) : detail.subgoals.length ? (
                          <div className="plan-list plan-list-collapsible">
                            <article className="plan-card plan-card-collapsible is-expanded">
                              <div className="plan-card-expanded">
                                <div className="panel-heading compact-heading">
                                  <div>
                                    <p className="eyebrow">{t("frontier.eyebrow")}</p>
                                    <h2>{t("frontier.title")}</h2>
                                  </div>
                                </div>
                                <div className="list-stack plan-subgoal-stack">
                                  {detail.subgoals.map((subgoal) => {
                                    const execution = executionBySubgoalId.get(subgoal.subgoal_id);
                                    const linkedDecision = latestDecisionBySubgoalId.get(subgoal.subgoal_id);
                                    const assignedWorkerId = assignedWorkerBySubgoalId.get(subgoal.subgoal_id);
                                    const assignedWorkerLabel = assignedWorkerId
                                      ? (workerNameById.get(assignedWorkerId) ?? assignedWorkerId)
                                      : t("common.unassigned");
                                    const stage = subgoalStage(subgoal.state, execution, linkedDecision);
                                    const inspectable = hasInspectableIssue(stage, linkedDecision);

                                    return (
                                      <div key={subgoal.subgoal_id} className={`plan-subgoal-card plan-subgoal-grid${subgoal.kind === "recon" ? " plan-subgoal-card-recon" : ""}`}>
                                        <div className="subgoal-zone subgoal-zone-main">
                                          <strong>
                                            {subgoal.title}
                                            {subgoal.kind === "recon" ? (
                                              <span className="subgoal-kind-badge subgoal-kind-recon" title={t("subgoal.recon_badge_title")}>RECON</span>
                                            ) : null}
                                          </strong>
                                          <p>{subgoal.objective}</p>
                                          {linkedDecision ? (
                                            <small className="subgoal-inline-note">
                                              {rawSubgoalIssueText(execution, latestWorkerResultByExecutionId.get(execution?.execution_id ?? ""), linkedDecision).split("\n")[0]}
                                            </small>
                                          ) : null}
                                        </div>
                                        <div className="subgoal-zone subgoal-zone-worker">
                                          <small>{t("subgoal.assigned_worker")}</small>
                                          <span className={`subgoal-assignment-badge${assignedWorkerId ? "" : " is-unassigned"}`}>
                                            {assignedWorkerLabel}
                                          </span>
                                        </div>
                                        <div className="subgoal-zone subgoal-zone-status">
                                          <button
                                            type="button"
                                            className={`subgoal-status-display subgoal-status-${stage}${inspectable ? " is-clickable" : ""}`}
                                            disabled={!inspectable}
                                            onClick={() => {
                                              if (!inspectable) {
                                                return;
                                              }
                                              openSubgoalDialog(
                                                subgoal.subgoal_id,
                                                stage === "success" ? "success" : stage === "failed" ? "failed" : "issue"
                                              );
                                            }}
                                          >
                                            {stageLabel(stage, linkedDecision)}
                                          </button>
                                          {stage === "running" && execution ? (
                                            <button
                                              type="button"
                                              className="subgoal-interrupt-button"
                                              title={t("subgoal.interrupt_title")}
                                              disabled={controlSubmittingId === execution.execution_id}
                                              onClick={(event) => {
                                                event.stopPropagation();
                                                if (!window.confirm(t("subgoal.interrupt_confirm", { title: subgoal.title }))) {
                                                  return;
                                                }
                                                void interruptExecution(execution.execution_id, detail.demand.demand_id, t("subgoal.interrupt_note", { title: subgoal.title }));
                                              }}
                                            >
                                              {controlSubmittingId === execution.execution_id ? "..." : t("subgoal.interrupt_label")}
                                            </button>
                                          ) : null}
                                        </div>
                                        {/* 执行中进度条放在卡片底部、横跨整行 —— 之前嵌在右列窄槽容易被忽略。
                                            注意：不再用 `&& execution` 守卫 —— subgoal 显示 running 但 execution
                                            row 尚未出现的早期窗口也要让用户看到占位卡。 */}
                                        {stage === "running" ? (
                                          <div className="plan-subgoal-progress-row">
                                            <RunningProgress execution={execution ?? null} />
                                          </div>
                                        ) : null}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            </article>
                          </div>
                        ) : (
                          detail.memory.filter((item) => item.category === "mission_state").map((item) => (
                            <p key={item.memory_id} className="bounded-copy">{item.content}</p>
                          ))
                        )}
                          </>
                        )}
                      </div>
                    </section>

                  </div>
                </div>
              )}

              {showCreateModal && (
                <div className="modal-layer" onClick={closeCreateModal}>
                  <div className={`create-modal${createModalExpanded ? " is-expanded" : ""}`} onClick={(event) => event.stopPropagation()}>
                    <div className="panel-heading">
                      <div>
                        <p className="eyebrow">{
                          detail && demandHasBrainError(detail.demand)
                            ? t("fault.eyebrow")
                            : detail && demandNeedsClarification(detail.demand)
                              ? t("create_demand.alignment_eyebrow")
                              : t("create_demand.new_eyebrow")
                        }</p>
                        <h2>{
                          detail && demandHasBrainError(detail.demand)
                            ? t("fault.title")
                            : detail && demandNeedsClarification(detail.demand)
                              ? t("create_demand.clarify_title")
                              : t("create_demand.create_title")
                        }</h2>
                      </div>
                      <button className="ghost-button" onClick={closeCreateModal}>{t("common.close")}</button>
                    </div>
                    {detail && demandNeedsClarification(detail.demand) ? (
                      <div className="alignment-modal-body">
                        <p className="bounded-copy">
                          {t("create_demand.alignment_copy")}
                        </p>
                        <div className="conversation-scroll modal-conversation-scroll">
                          {conversationHistory.map((message, index) => {
                            const isReconFindings = message.role === "assistant" && message.content.startsWith("[Recon findings]");
                            const displayContent = isReconFindings
                              ? message.content.replace(/^\[Recon findings\]\s*/, "")
                              : message.content;
                            const label = isReconFindings
                              ? t("alignment.recon_findings")
                              : message.role === "assistant" ? t("common.assistant") : t("common.you");
                            const cls = `conversation-turn ${message.role === "assistant" ? "assistant" : "user"}${isReconFindings ? " conversation-turn-recon-findings" : ""}`;
                            return (
                              <div key={`${message.created_at}-${index}`} className={cls}>
                                <small>{label}</small>
                                <p>{displayContent}</p>
                              </div>
                            );
                          })}
                          {assistantTyping ? (
                            <div className="conversation-turn assistant conversation-turn-typing">
                              <small>{t("common.assistant")}</small>
                              <div className="typing-dots"><span>.</span><span>.</span><span>.</span></div>
                            </div>
                          ) : null}
                        </div>
                        {detail.demand.metadata?.clarification_question ? (
                          <>
                            <label className="field">
                              <span>{t("alignment.reply_label")}</span>
                              <textarea
                                value={clarificationReply}
                                onChange={(event) => setClarificationReply(event.target.value)}
                                placeholder={t("alignment.reply_placeholder")}
                              />
                            </label>
                            <div className="modal-actions">
                              <button className="ghost-button" onClick={closeCreateModal}>{t("common.cancel")}</button>
                              <button className="primary" disabled={replySubmitting || !clarificationReply.trim()} onClick={sendClarificationReply}>{replySubmitting ? t("common.sending") : t("alignment.send_reply")}</button>
                            </div>
                          </>
                        ) : (
                          <p className="bounded-copy">{t("alignment.waiting_turn")}</p>
                        )}
                      </div>
                    ) : (
                      <>
                        <p className="bounded-copy">
                          {t("create_demand.copy")}
                        </p>
                        <div className="textarea-expandable">
                          <textarea
                            value={newDemand}
                            onChange={(event) => setNewDemand(event.target.value)}
                            placeholder={t("create_demand.placeholder")}
                          />
                          <button
                            type="button"
                            className="textarea-expand-toggle"
                            onClick={() => setCreateModalExpanded((value) => !value)}
                            aria-label={createModalExpanded ? t("create_demand.collapse") : t("create_demand.expand")}
                            title={createModalExpanded ? t("create_demand.collapse") : t("create_demand.expand")}
                          >
                            {createModalExpanded ? (
                              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                                <path d="M3 7h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                              </svg>
                            ) : (
                              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                                <path d="M7 3v8M3 7h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                              </svg>
                            )}
                          </button>
                        </div>
                        <div className="modal-actions">
                          <button className="primary" disabled={createSubmitting || !newDemand.trim()} onClick={createDemand}>{createSubmitting ? t("common.creating") : t("create_demand.submit")}</button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}

              {dashboardView === "detail" && selectedSubgoalDialog && selectedDialogSubgoal && (
                <div className={`decision-modal-layer${subgoalDialogClosing ? " is-closing" : ""}`} onClick={closeSubgoalDialog}>
                  <div className={`decision-modal subgoal-result-modal${subgoalDialogClosing ? " is-closing" : ""}`} onClick={(event) => event.stopPropagation()}>
                    <div className="panel-heading">
                      <div>
                        <p className="eyebrow">{t("subgoal_detail.eyebrow")}</p>
                        <h2>{selectedDialogSubgoal.title}</h2>
                      </div>
                      <button className="ghost-button" type="button" onClick={closeSubgoalDialog}>
                        {t("common.close")}
                      </button>
                    </div>
                    {selectedSubgoalDialog.mode === "success" ? (
                      <div className="subgoal-result-stack">
                        <section className="decision-modal-card subgoal-result-card">
                          <div className="decision-modal-head">
                            <small className="pill pill-success">{t("subgoal_detail.succeeded")}</small>
                            {selectedDialogExecution ? <small>{selectedDialogExecution.execution_id}</small> : null}
                          </div>
                          <div className="subgoal-result-block">
                            <span className="subgoal-result-label">{t("subgoal_detail.result")}</span>
                            <pre className="decision-modal-prompt">{selectedDialogExecution?.claimed_outcome || selectedDialogExecution?.compressed_history || t("subgoal_detail.no_result")}</pre>
                          </div>
                          <div className="subgoal-result-block">
                            <span className="subgoal-result-label">{t("subgoal_detail.artifacts")}</span>
                            {selectedDialogExecution?.artifacts?.length ? (
                              <div className="artifact-list">
                                {selectedDialogExecution.artifacts.map((artifact) => (
                                  <div key={artifact.artifact_id} className="artifact-item">
                                    <strong>{artifact.artifact_type}</strong>
                                    <code>{artifact.uri}</code>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="bounded-copy">{t("subgoal_detail.no_artifacts")}</p>
                            )}
                          </div>
                        </section>
                      </div>
                    ) : (
                      <div className="subgoal-result-stack">
                        <section className="decision-modal-card subgoal-result-card">
                          <div className="decision-modal-head">
                            <small className={`pill ${selectedSubgoalDialog.mode === "failed" ? "pill-danger" : "pill-warning"}`}>
                              {selectedSubgoalDialog.mode === "failed" ? t("subgoal_detail.failed") : t("subgoal_detail.pending")}
                            </small>
                            {selectedDialogDecision?.reason_code ? <small>{selectedDialogDecision.reason_code}</small> : null}
                          </div>
                          <div className="subgoal-result-block">
                            <span className="subgoal-result-label">
                              {selectedSubgoalDialog.mode === "failed" ? t("subgoal_detail.failure_detail") : t("subgoal_detail.decision_detail")}
                            </span>
                            <pre className="decision-modal-prompt">
                              {selectedDialogWorkerResult?.blocker_reason?.message
                                || rawSubgoalIssueText(selectedDialogExecution, selectedDialogWorkerResult, selectedDialogDecision)
                                || selectedDialogExecution?.claimed_outcome
                                || selectedDialogExecution?.compressed_history
                                || t("subgoal_detail.no_detail")}
                            </pre>
                          </div>
                          <div className="subgoal-result-block">
                            <span className="subgoal-result-label">{t("subgoal_detail.reason")}</span>
                            <p className="bounded-copy">
                              {selectedDialogDecision?.reason_code
                                || selectedDialogExecution?.result_status
                                || selectedDialogExecution?.state
                                || t("common.unknown")}
                            </p>
                          </div>
                        </section>
                        <section className="decision-modal-card subgoal-result-card">
                          <div className="decision-modal-head">
                            <small className="pill pill-warning">{t("subgoal_detail.suggestions")}</small>
                          </div>
                          <div className="suggestion-dialogue">
                            {selectedDecisionConversation.length ? (
                              selectedDecisionConversation.map((message, index) => (
                                <div
                                  key={`${message.created_at}-${index}`}
                                  className={`conversation-turn ${message.role === "assistant" ? "assistant" : "user"} suggestion-turn`}
                                >
                                  <small>{message.role === "assistant" ? t("demand.detail.assistant") : t("common.you")}</small>
                                  {message.role === "assistant" ? (
                                    <p className="suggestion-message">{summarizeDecisionPrompt(message.content)}</p>
                                  ) : (
                                    <p>{message.content}</p>
                                  )}
                                </div>
                              ))
                            ) : (
                              <div className="conversation-turn assistant suggestion-turn">
                                <small>{t("demand.detail.assistant")}</small>
                                <p className="suggestion-message">
                                  {summarizeDecisionPrompt(selectedDialogDecision?.prompt ?? t("subgoal_detail.default_prompt"))}
                                </p>
                              </div>
                            )}
                            {decisionSubmitting === selectedDialogDecision?.decision_id ? (
                              <div className="conversation-turn assistant suggestion-turn conversation-turn-typing">
                                <small>{t("demand.detail.assistant")}</small>
                                <div className="typing-dots"><span>.</span><span>.</span><span>.</span></div>
                              </div>
                            ) : null}
                          </div>
                          {selectedDialogDecision && selectedDialogDecision.status === "OPEN" ? (
                            <p className="subgoal-detail-reply-hint bounded-copy">
                              {t("subgoal_detail.reply_in_panel")}
                            </p>
                          ) : null}
                        </section>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </section>
          </>
        )}

        {tab === "Workers" && (
          <section className="content single">
            <div className="hero-panel compact">
              <div className="hero-copy">
                <p className="eyebrow">{t("workers.eyebrow")}</p>
                <h1>{t("workers.title")}</h1>
              </div>
              <div className="hero-metrics">
                <div className="metric-card">
                  <span>{t("workers.total")}</span>
                  <strong>{workers.length}</strong>
                </div>
                <button type="button" className="metric-card worker-add-card" onClick={() => setShowWorkerCreateModal(true)}>
                  <span>{t("workers.add")}</span>
                  <strong>+</strong>
                </button>
              </div>
            </div>
            <div className="worker-tiles">
              {workerTiles.map((worker) => (
                <div
                  key={worker.key}
                  className="worker-tile worker-tile-clickable"
                  onClick={() => {
                    const target = workers.find((w) => w.worker_id === worker.key);
                    if (target) openWorkerDetail(target);
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div className="worker-tile-top">
                    <span className={`worker-lamp worker-lamp-${worker.lamp}`} />
                    <small>{worker.subtitle}</small>
                    <div className="worker-tile-actions" onClick={(event) => event.stopPropagation()}>
                      <button
                        type="button"
                        className="worker-tile-action"
                        title={t("workers.rename_title")}
                        onClick={() => void renameWorker(worker.key, worker.name)}
                      >
                        ✏️
                      </button>
                      <button
                        type="button"
                        className="worker-tile-action worker-tile-action-danger"
                        title={t("workers.delete_title")}
                        onClick={() => void deleteWorker(worker.key, worker.name)}
                      >
                        🗑
                      </button>
                    </div>
                  </div>
                  <strong>{worker.name}</strong>
                  {worker.status ? <small>{worker.status}</small> : null}
                  {worker.meta ? <p className="worker-tile-meta">{worker.meta}</p> : null}
                  <div className="worker-capabilities">
                    {worker.capabilities.map((capability) => (
                      <span key={`${worker.key}-${capability}`} className="worker-capability-chip">{capability}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {detail && (
              <div className="worker-grid worker-runtime-grid">
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <p className="eyebrow">{t("runtime.eyebrow")}</p>
                      <h2>{t("runtime.title")}</h2>
                    </div>
                  </div>
                  <div className="list-stack">
                    {detail.executions.map((item) => (
                      <div key={item.execution_id} className="row row-card">
                        <div>
                          <strong>{item.worker_id}</strong>
                          <p>{item.execution_id}</p>
                        </div>
                        <small className={`pill pill-${stateTone(item.latest_worker_status ?? item.state)}`}>
                          {item.latest_worker_status ?? item.state}
                        </small>
                      </div>
                    ))}
                  </div>
                </section>
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <p className="eyebrow">{t("trace.eyebrow")}</p>
                      <h2>{t("trace.title")}</h2>
                    </div>
                  </div>
                  {hiddenHeartbeatCount > 0 && (
                    <p className="panel-note">{t("panel.heartbeats_hidden", { count: hiddenHeartbeatCount })}</p>
                  )}
                  <div className="list-stack">
                    {visibleTimelineEvents.map((item) => {
                      const human = humanizeEvent(item, t);
                      return (
                        <div
                          key={item.event_id}
                          className={`timeline-item timeline-card timeline-tone-${human.tone}`}
                          title={`${item.event_type} @ ${item.created_at}`}
                        >
                          <strong>{human.label}</strong>
                          <small>{formatRelativeShort(item.created_at, Date.now(), t)}</small>
                        </div>
                      );
                    })}
                  </div>
                </section>
              </div>
            )}
          </section>
        )}

        {/* Worker 详情弹窗：点击 worker 卡片打开，展示 adapter / runtime / config / env / 状态 */}
        {tab === "Workers" && selectedWorkerId && workerEditDraft && (() => {
          const w = workers.find((item) => item.worker_id === selectedWorkerId);
          if (!w) return null;
          const cfg = w.config ?? {};
          const envEntries = Object.entries(cfg.env ?? {});
          const draft = workerEditDraft;
          // 关键：用 createPortal 把 modal 挂到 document.body，逃出 <main class="layout">
          // (z-index:10) 这个父级 stacking context。否则就算 .modal-layer 自己有 z-index:50，
          // 它也只在 .layout 内部参与排序，外面的 .topbar (z-index:20) / .action-required-bar (z-index:19)
          // 仍然会盖住它的某些区域 —— 用户体感就是"close 点不到，按了没反应"。
          return createPortal(
            <div className="modal-layer" onClick={closeWorkerDetail}>
              <div className="create-modal worker-detail-modal" onClick={(event) => event.stopPropagation()}>
                <div className="panel-heading">
                  <div>
                    <p className="eyebrow">{t("worker_detail.eyebrow")}</p>
                    <h2>{w.name}</h2>
                  </div>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      closeWorkerDetail();
                    }}
                  >
                    {t("common.close")}
                  </button>
                </div>
                <div className="worker-detail-grid">
                  <div className="worker-detail-row">
                    <span>{t("worker_detail.id")}</span>
                    <code>{w.worker_id}</code>
                  </div>
                  <div className="worker-detail-row">
                    <span>{t("worker_detail.adapter")}</span>
                    <strong>{w.adapter_type}</strong>
                  </div>
                  <label className="field worker-detail-field">
                    <span>{t("workers.modal.field.name")}</span>
                    <input
                      value={draft.name}
                      onChange={(event) => updateWorkerEditDraft("name", event.target.value)}
                    />
                  </label>
                  <label className="field worker-detail-field">
                    <span>{t("worker_detail.runtime")}</span>
                    <select
                      value={draft.runtime_type}
                      onChange={(event) => updateWorkerEditDraft("runtime_type", event.target.value as RuntimeType)}
                    >
                      <option value="local_command">local_command</option>
                      <option value="http">http</option>
                      <option value="websocket">websocket</option>
                    </select>
                  </label>
                  <label className="field worker-detail-field">
                    <span>{t("workers.modal.field.workspace")}</span>
                    <input
                      value={draft.workspace_root}
                      onChange={(event) => updateWorkerEditDraft("workspace_root", event.target.value)}
                      placeholder={t("settings.general.workspace.placeholder")}
                    />
                  </label>
                  <label className="field worker-detail-field">
                    <span>{t("workers.modal.field.capabilities")}</span>
                    <input
                      value={draft.capabilities}
                      onChange={(event) => updateWorkerEditDraft("capabilities", event.target.value)}
                      placeholder={t("worker_create.capabilities_placeholder")}
                    />
                  </label>
                  <label className="field worker-detail-field">
                    <span>{t("worker_detail.max_concurrency")}</span>
                    <input
                      type="number"
                      min="1"
                      value={draft.max_concurrency}
                      onChange={(event) => updateWorkerEditDraft("max_concurrency", Number(event.target.value))}
                    />
                  </label>
                  <label className="field worker-detail-field">
                    <span>{t("workers.modal.field.endpoint")}</span>
                    <input
                      value={draft.endpoint}
                      onChange={(event) => updateWorkerEditDraft("endpoint", event.target.value)}
                      placeholder={t("workers.detail.endpoint_placeholder")}
                    />
                  </label>
                  <div className="worker-detail-row">
                    <span>{t("worker_detail.status")}</span>
                    <strong>{w.status}</strong>
                  </div>
                  <div className="worker-detail-row">
                    <span>{t("worker_detail.active_executions")}</span>
                    <strong>{w.current_execution_ids?.length ?? 0}</strong>
                  </div>
                  <div className="worker-detail-row">
                    <span>{t("worker_detail.last_seen")}</span>
                    <strong>{w.last_seen_at ? formatRelativeShort(w.last_seen_at, Date.now(), t) : t("common.dash")}</strong>
                  </div>
                  {w.last_error ? (
                    <div className="worker-detail-row worker-detail-row-error">
                      <span>{t("worker_detail.last_error")}</span>
                      <code>{w.last_error}</code>
                    </div>
                  ) : null}
                  <div className="worker-detail-section">
                    <p className="eyebrow">{t("worker_detail.adapter_config")}</p>
                    <div className="worker-detail-config">
                      {cfg.command ? (
                        <div className="worker-detail-row">
                          <span>command</span>
                          <code>{cfg.command}</code>
                        </div>
                      ) : null}
                      {cfg.args && cfg.args.length > 0 ? (
                        <div className="worker-detail-row">
                          <span>args</span>
                          <code>{cfg.args.join(" ")}</code>
                        </div>
                      ) : null}
                      {cfg.timeout_seconds !== undefined ? (
                        <div className="worker-detail-row">
                          <span>timeout</span>
                          <strong>{cfg.timeout_seconds}s</strong>
                        </div>
                      ) : null}
                      {envEntries.length > 0 ? (
                        <div className="worker-detail-row">
                          <span>env</span>
                          <div className="worker-detail-env">
                            {envEntries.map(([k, v]) => (
                              <code key={k}>{k}={v}</code>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
                <div className="worker-detail-footer">
                  <button
                    type="button"
                    className="ghost-button danger-button"
                    onClick={() => {
                      closeWorkerDetail();
                      void deleteWorker(w.worker_id, w.name);
                    }}
                  >
                    🗑 {t("workers.detail.delete")}
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={workerEditSubmitting}
                    onClick={() => void saveWorkerEdit()}
                  >
                    {workerEditSubmitting ? t("workers.detail.saving") : t("workers.detail.save")}
                  </button>
                </div>
              </div>
            </div>,
            document.body
          );
        })()}

        {tab === "Workers" && showWorkerCreateModal && (
          <div className="modal-layer" onClick={() => setShowWorkerCreateModal(false)}>
            <div className="create-modal worker-create-modal" onClick={(event) => event.stopPropagation()}>
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">{t("worker_create.eyebrow")}</p>
                  <h2>{t("worker_create.title")}</h2>
                </div>
                <button className="ghost-button" onClick={() => setShowWorkerCreateModal(false)}>{t("common.close")}</button>
              </div>
              <p className="bounded-copy">
                {t("worker_create.copy")}
              </p>
              <label className="field">
                <span>{t("workers.modal.field.name")}</span>
                <input
                  value={workerDraft.name}
                  onChange={(event) => updateWorkerDraft("name", event.target.value)}
                  placeholder={t("worker_create.name_placeholder")}
                />
              </label>
              <div className="worker-form-grid">
                <label className="field">
                  <span>{t("workers.modal.field.adapter")}</span>
                  <select
                    value={workerDraft.adapter_type}
                    onChange={(event) => updateWorkerDraft("adapter_type", event.target.value as AdapterType)}
                  >
                    {/* 按 review 反馈仅支持 claude_code + codex，opencode 已从默认 worker 移除 */}
                    <option value="claude_code">claude_code</option>
                    <option value="codex">codex</option>
                  </select>
                </label>
                <label className="field">
                  <span>{t("workers.modal.field.runtime")}</span>
                  <select
                    value={workerDraft.runtime_type}
                    onChange={(event) => updateWorkerDraft("runtime_type", event.target.value as RuntimeType)}
                  >
                    <option value="local_command">local_command</option>
                    <option value="http">http</option>
                    <option value="websocket">websocket</option>
                  </select>
                </label>
              </div>
              <label className="field">
                <span>{t("workers.modal.field.workspace")}</span>
                <input
                  value={workerDraft.workspace_root}
                  onChange={(event) => updateWorkerDraft("workspace_root", event.target.value)}
                  placeholder={settingsDraft.workspace_root || settings.workspace_root || t("settings.general.workspace.placeholder")}
                />
              </label>
              <label className="field">
                <span>{t("workers.modal.field.capabilities")}</span>
                <input
                  value={workerDraft.capabilities}
                  onChange={(event) => updateWorkerDraft("capabilities", event.target.value)}
                  placeholder={t("worker_create.capabilities_placeholder")}
                />
              </label>
              <div className="worker-form-grid">
                <label className="field">
                  <span>{t("workers.modal.field.concurrency")}</span>
                  <input
                    type="number"
                    min="1"
                    value={workerDraft.max_concurrency}
                    onChange={(event) => updateWorkerDraft("max_concurrency", Number(event.target.value))}
                  />
                </label>
                <label className="field">
                  <span>{t("workers.modal.field.endpoint")}</span>
                  <input
                    value={workerDraft.endpoint}
                    onChange={(event) => updateWorkerDraft("endpoint", event.target.value)}
                    placeholder={t("worker_create.endpoint_placeholder")}
                  />
                </label>
              </div>
              {workerDraft.adapter_type === "codex" ? (
                <div className="worker-form-grid">
                  <label className="field">
                    <span>{t("workers.modal.field.command")}</span>
                    <input
                      value={workerDraft.command}
                      onChange={(event) => updateWorkerDraft("command", event.target.value)}
                      placeholder={t("worker_create.command_placeholder")}
                    />
                  </label>
                  <label className="field">
                    <span>{t("workers.modal.field.args")}</span>
                    <input
                      value={workerDraft.args}
                      onChange={(event) => updateWorkerDraft("args", event.target.value)}
                      placeholder={t("worker_create.args_placeholder")}
                    />
                  </label>
                </div>
              ) : null}
              <div className="modal-actions">
                <button className="ghost-button" onClick={() => setShowWorkerCreateModal(false)}>{t("common.cancel")}</button>
	                <button
                    className="primary"
                    disabled={
                      workerSubmitting ||
                      !workerDraft.name.trim() ||
                      !(workerDraft.workspace_root.trim() || settingsDraft.workspace_root || settings.workspace_root) ||
                      parseCsv(workerDraft.capabilities).length === 0
                    }
                    onClick={() => void registerWorker()}
                  >
	                  {workerSubmitting ? t("common.creating") : t("worker_create.submit")}
	                </button>
              </div>
            </div>
          </div>
        )}

        {tab === "Settings" && (
          <section className="content single settings-content">
            <div className="panel settings-panel">
              <nav className="subtabs">
                <button
                  type="button"
                  className={`subtab${settingsTab === "general" ? " is-active" : ""}`}
                  onClick={() => setSettingsTab("general")}
                >
                  {t("settings.tab.general")}
                </button>
                <button
                  type="button"
                  className={`subtab${settingsTab === "brain" ? " is-active" : ""}`}
                  onClick={() => setSettingsTab("brain")}
                >
                  {t("settings.tab.brain")}
                </button>
              </nav>

              {settingsStatus && <p className="settings-status">{settingsStatus}</p>}

              {settingsTab === "general" && (
                <>
                  <section className="settings-section">
                    <div className="settings-section-head">
                      <h3>{t("settings.general.workspace.title")}</h3>
                      <small>{t("settings.general.workspace.desc")}</small>
                    </div>
                    <label className="field">
                      <input
                        value={settingsDraft.workspace_root}
                        onChange={(event) => updateWorkspaceRoot(event.target.value)}
                        placeholder={t("settings.general.workspace.placeholder")}
                      />
                    </label>
                  </section>

                  <section className="settings-section workspace-grants-section">
                    <div className="settings-section-head">
                      <h3>{t("settings.general.grants.title")}</h3>
                      <small>{t("settings.general.grants.desc")}</small>
                    </div>
                    <div className="workspace-grants-list">
                      {((settingsDraft.workspace_grants ?? []) as Array<{ path: string; granted_at: string }>).length === 0 ? (
                        <p className="workspace-grants-empty">{t("settings.general.grants.empty")}</p>
                      ) : (
                        ((settingsDraft.workspace_grants ?? []) as Array<{ path: string; granted_at: string }>).map((grant) => (
                          <div key={grant.path} className="workspace-grant-row">
                            <code>{grant.path}</code>
                            <small className="workspace-grant-meta">
                              {grant.granted_at ? t("settings.general.grants.added_at", { ago: formatRelativeShort(grant.granted_at, Date.now(), t) }) : ""}
                            </small>
                            <button
                              type="button"
                              className="workspace-grant-remove"
                              title={t("settings.general.grants.remove_title")}
                              onClick={() => removeWorkspaceGrant(grant.path)}
                            >
                              🗑
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                    <div className="workspace-grants-add">
                      <input
                        type="text"
                        placeholder={t("settings.general.grants.placeholder")}
                        value={newGrantInput}
                        onChange={(event) => setNewGrantInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && newGrantInput.trim()) {
                            addWorkspaceGrant(newGrantInput);
                            setNewGrantInput("");
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="ghost-button"
                        disabled={!newGrantInput.trim()}
                        onClick={() => {
                          addWorkspaceGrant(newGrantInput);
                          setNewGrantInput("");
                        }}
                      >
                        {t("settings.general.grants.add")}
                      </button>
                    </div>
                  </section>

                  <section className="settings-section">
                    <div className="settings-section-head">
                      <h3>{t("settings.general.language.title")}</h3>
                      <small>{t("settings.general.language.desc")}</small>
                    </div>
                    <div className="language-segmented">
                      <button
                        type="button"
                        className={`language-option${language === "en" ? " is-active" : ""}`}
                        onClick={() => setLanguage("en")}
                      >
                        {t("settings.general.language.en")}
                      </button>
                      <button
                        type="button"
                        className={`language-option${language === "zh" ? " is-active" : ""}`}
                        onClick={() => setLanguage("zh")}
                      >
                        {t("settings.general.language.zh")}
                      </button>
                    </div>
                  </section>

                  <div className="settings-footer">
                    <button className="primary" disabled={!settingsDirty || settingsSaving} onClick={saveSettings}>
                      {settingsSaving ? t("common.sending") : t("settings.save_button")}
                    </button>
                  </div>
                </>
              )}

              {settingsTab === "brain" && (
                <>
                  <section className="settings-section">
                    <div className="settings-section-head">
                      <h3>{t("settings.brain.title")}</h3>
                      <small>{t("settings.brain.desc")}</small>
                    </div>
                  </section>

                  <div className="settings-grid">
                    {(Object.keys(settingsDraft.models) as Array<keyof Settings["models"]>).map((role) => {
                      const model = settingsDraft.models[role];
                      return (
                        <section key={role} className="settings-card">
                          <div className="settings-card-header">
                            <h3>{t(`settings.brain.role.${role}`)}</h3>
                          </div>

                          <label className="field">
                            <span>{t("settings.brain.field.provider")}</span>
                            <input
                              value={model.provider}
                              onChange={(event) => updateModel(role, "provider", event.target.value)}
                              placeholder={t("settings.brain.field.provider.placeholder")}
                            />
                          </label>

                          <label className="field">
                            <span>{t("settings.brain.field.model")}</span>
                            <input
                              value={model.model}
                              onChange={(event) => updateModel(role, "model", event.target.value)}
                              placeholder={t("settings.brain.field.model.placeholder")}
                            />
                          </label>

                          <label className="field">
                            <span>{t("settings.brain.field.base_url")}</span>
                            <input
                              value={model.base_url}
                              onChange={(event) => updateModel(role, "base_url", event.target.value)}
                              placeholder={t("settings.brain.field.base_url.placeholder")}
                            />
                          </label>

                          <label className="field">
                            <span>{t("settings.brain.field.api_key")}</span>
                            <input
                              type="password"
                              value={model.api_key}
                              onChange={(event) => updateModel(role, "api_key", event.target.value)}
                              placeholder={t("settings.brain.field.api_key.placeholder")}
                            />
                          </label>
                        </section>
                      );
                    })}
                  </div>

                  <div className="settings-grid">
                    <section className="settings-card">
                      <h3>{t("settings.brain.runtime.title")}</h3>
                      <label className="field">
                        <span>{t("settings.brain.runtime.heartbeat")}</span>
                        <input
                          type="number"
                          value={settingsDraft.runtime.heartbeat_interval_seconds}
                          onChange={(event) => updateRuntime("heartbeat_interval_seconds", Number(event.target.value))}
                        />
                      </label>
                      <label className="field">
                        <span>{t("settings.brain.runtime.timeout")}</span>
                        <input
                          type="number"
                          value={settingsDraft.runtime.execution_timeout_seconds}
                          onChange={(event) => updateRuntime("execution_timeout_seconds", Number(event.target.value))}
                        />
                      </label>
                      <label className="field">
                        <span>{t("settings.brain.runtime.retry")}</span>
                        <input
                          type="number"
                          value={settingsDraft.runtime.max_retry_count}
                          onChange={(event) => updateRuntime("max_retry_count", Number(event.target.value))}
                        />
                      </label>
                      <label className="field">
                        <span>{t("settings.brain.runtime.llm_timeout")}</span>
                        <input
                          type="number"
                          min={5}
                          value={settingsDraft.runtime.llm_timeout_seconds}
                          onChange={(event) => updateRuntime("llm_timeout_seconds", Number(event.target.value))}
                        />
                      </label>
                    </section>

                    <section className="settings-card">
                      <h3>{t("settings.brain.snapshot.title")}</h3>
                      <pre>{JSON.stringify(settings, null, 2)}</pre>
                    </section>
                  </div>

                  <div className="settings-footer">
                    <button className="primary" disabled={!settingsDirty || settingsSaving} onClick={saveSettings}>
                      {settingsSaving ? t("common.sending") : t("settings.save_button")}
                    </button>
                  </div>
                </>
              )}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
