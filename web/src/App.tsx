import type { CSSProperties } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { apiRequest } from "./api/client";
import { createNodiktSocket } from "./api/socket";
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
    primary: { provider: "", model: "", base_url: "", api_key: "", enabled: false },
    planner: { provider: "", model: "", base_url: "", api_key: "", enabled: false },
    verifier: { provider: "", model: "", base_url: "", api_key: "", enabled: false },
    ops_backup: { provider: "", model: "", base_url: "", api_key: "", enabled: false }
  },
  workspace_root: "",
  runtime: {
    heartbeat_interval_seconds: 30,
    execution_timeout_seconds: 600,
    max_retry_count: 1
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

function formatElapsedShort(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "刚开始";
  const sec = Math.floor(elapsedMs / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return `${min} 分 ${rem.toString().padStart(2, "0")} 秒`;
  const hr = Math.floor(min / 60);
  return `${hr} 时 ${(min % 60).toString().padStart(2, "0")} 分`;
}

function formatRelativeShort(fromIso: string | null | undefined, nowMs: number): string {
  if (!fromIso) return "—";
  const t = new Date(fromIso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diff = Math.max(0, nowMs - t);
  const sec = Math.floor(diff / 1000);
  if (sec < 5) return "刚刚";
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
}

/**
 * 把后端 EventType 枚举翻译成自然语言，给 Recent Events 时间线展示。
 * 返回 { label, tone }：label 是要给客户看的中文句子，tone 用于决定卡片样式色。
 * 缺省 fallback 是原 event_type 字符串 + neutral —— 避免 enum 新增时前端崩。
 */
function humanizeEvent(event: DemandEvent): { label: string; tone: "neutral" | "info" | "success" | "warning" | "danger" } {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.event_type) {
    case "USER_INPUT_RECEIVED": {
      const kind = typeof payload.input_kind === "string" ? payload.input_kind : "";
      if (kind === "recon_findings") return { label: "已收到调研结果，继续推进澄清", tone: "info" };
      if (kind === "clarification_reply") return { label: "已收到你的澄清回复", tone: "info" };
      return { label: "已收到你的需求输入", tone: "info" };
    }
    case "DEMAND_CREATED":
      return { label: "已创建需求", tone: "info" };
    case "DEMAND_CLARIFICATION_COMPLETED":
      return { label: "需求澄清完成，进入规划阶段", tone: "success" };
    case "PLAN_GENERATED":
      return { label: "已生成执行计划", tone: "success" };
    case "SUBGOAL_CREATED":
      return { label: "已创建子目标", tone: "info" };
    case "SUBGOAL_MARKED_READY":
      return { label: "子目标已就绪，准备派发", tone: "info" };
    case "EXECUTION_CREATED":
      return { label: "已为子目标创建执行", tone: "info" };
    case "EXECUTION_DISPATCHED":
      return { label: "已派发到 worker", tone: "info" };
    case "WORKER_RESULT_RECEIVED": {
      const wr = payload.worker_result as { worker_status?: string | null } | undefined;
      const status = wr?.worker_status ?? "";
      if (status === "DONE") return { label: "Worker 已完成", tone: "success" };
      if (status === "FAILED") return { label: "Worker 报告失败", tone: "danger" };
      if (status === "NEED_HELP" || status === "BLOCKED") return { label: "Worker 需要进一步指示", tone: "warning" };
      return { label: "已收到 worker 结果", tone: "info" };
    }
    case "VERIFICATION_COMPLETED": {
      const vr = payload.verification_result as { verified_status?: string } | undefined;
      const status = vr?.verified_status ?? typeof payload.verification_status === "string" ? payload.verification_status : "";
      if (status === "VERIFIED_DONE") return { label: "验证通过", tone: "success" };
      if (status === "PARTIAL") return { label: "部分验证通过，继续推进", tone: "info" };
      if (status === "FAILED") return { label: "验证未通过", tone: "danger" };
      if (status === "UNVERIFIABLE") return { label: "无法验证结果", tone: "warning" };
      return { label: "验证已完成", tone: "info" };
    }
    case "RECONCILIATION_COMPLETED": {
      const replan = Boolean(payload.replan_requested);
      const mission = Boolean(payload.mission_completed);
      if (mission) return { label: "整体任务完成", tone: "success" };
      if (replan) return { label: "完成结果归并，准备重新规划", tone: "info" };
      return { label: "已归并执行结果", tone: "info" };
    }
    case "SUBGOAL_RETRY_REQUESTED":
      return { label: "正在自动重试此子目标", tone: "warning" };
    case "DECISION_REQUEST_CREATED": {
      const dr = payload.decision_request as { reason_code?: string } | undefined;
      const reason = dr?.reason_code ?? "";
      if (reason === "PLAN_REVIEW") return { label: "等待你审核新的执行计划", tone: "warning" };
      if (reason === "PATH_GRANT_REQUIRED") return { label: "等待你授权输出目录", tone: "warning" };
      if (reason === "OPS_ALERT") return { label: "运维异常，等待你处理", tone: "danger" };
      if (reason === "UNVERIFIABLE_RESULT") return { label: "结果无法验证，等待你裁决", tone: "warning" };
      if (reason === "BLOCKED") return { label: "执行受阻，等待你裁决", tone: "warning" };
      return { label: "需要你做一个决策", tone: "warning" };
    }
    case "DECISION_RESPONSE_RECEIVED": {
      const dr = payload.decision_response as { action?: string } | undefined;
      const action = dr?.action ?? "";
      if (action === "Approve") return { label: "你已批准，继续推进", tone: "success" };
      if (action === "Reject") return { label: "你已拒绝", tone: "danger" };
      if (action === "ProvideInfo") return { label: "你已补充信息", tone: "info" };
      if (action === "CancelDemand") return { label: "已取消此需求", tone: "danger" };
      return { label: "已收到你的回复", tone: "info" };
    }
    case "REPLAN_REQUESTED":
      return { label: "正在根据反馈调整计划", tone: "info" };
    case "DEMAND_PAUSED":
      return { label: "需求已暂停", tone: "warning" };
    case "DEMAND_RESUMED":
      return { label: "需求已恢复", tone: "info" };
    case "DEMAND_CANCELLED":
      return { label: "需求已取消", tone: "danger" };
    case "EXECUTION_STOP_REQUESTED":
      return { label: "正在中断当前执行", tone: "warning" };
    case "EXECUTION_TIMEOUT_DETECTED":
      return { label: "执行超时", tone: "warning" };
    case "WORKER_HEALTH_CHECKED": {
      const ok = Boolean(payload.ok);
      return ok
        ? { label: "Worker 健康检查通过", tone: "neutral" }
        : { label: "Worker 健康检查失败", tone: "warning" };
    }
    case "OPS_RECOVERY_ATTEMPTED":
      return { label: "已尝试自动恢复", tone: "info" };
    case "OPS_RECOVERY_FAILED":
      return { label: "自动恢复失败", tone: "danger" };
    case "OPS_ALERT":
      return { label: "运维告警", tone: "warning" };
    case "MISSION_COMPLETED":
      return { label: "整体任务完成", tone: "success" };
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
  const now = useTickingClock(true, 1000);

  // execution=null 的早期窗口：subgoal 显示 running 但 execution row 还没出现
  if (!execution) {
    return (
      <div className="running-progress running-progress-queued">
        <div className="running-progress-row">
          <span className="running-progress-pulse" aria-hidden="true" />
          <span className="running-progress-label">排队中…</span>
          <span className="running-progress-elapsed">worker 即将接管</span>
        </div>
        <div className="running-progress-meta">
          <span>等待派发到 worker</span>
        </div>
      </div>
    );
  }

  const startedMs = execution.started_at ? new Date(execution.started_at).getTime() : null;
  const elapsed = startedMs ? Math.max(0, now - startedMs) : 0;
  const { steps, lastAction } = extractToolProgress(execution);
  const heartbeatRelative = formatRelativeShort(execution.last_heartbeat_at, now);
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
    ? "排队中…"
    : renderState === "stale"
      ? "心跳停滞，可能卡住"
      : "执行中";
  const elapsedText = startedMs ? `已运行 ${formatElapsedShort(elapsed)}` : "等待 worker 启动";

  return (
    <div className={`running-progress running-progress-${renderState}`}>
      <div className="running-progress-row">
        <span className="running-progress-pulse" aria-hidden="true" />
        <span className="running-progress-label">{stateLabel}</span>
        <span className="running-progress-elapsed">{elapsedText}</span>
      </div>
      <div className="running-progress-meta">
        {steps > 0 ? <span>已完成 {steps} 步</span> : <span>等待 worker 上报第一步</span>}
        <span>·</span>
        <span title={execution.last_heartbeat_at ?? ""}>
          {execution.last_heartbeat_at ? `${heartbeatRelative}活跃` : "尚未心跳"}
        </span>
      </div>
      {lastAction ? (
        <div className="running-progress-action" title={lastAction}>
          正在 {lastAction}
        </div>
      ) : null}
    </div>
  );
}

export function App() {
  const [tab, setTab] = useState<"Dashboard" | "Workers" | "Settings">("Dashboard");
  const [dashboardView, setDashboardView] = useState<"board" | "detail" | "create">("board");
  const [demands, setDemands] = useState<Demand[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [showWorkerCreateModal, setShowWorkerCreateModal] = useState(false);
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const [workerDraft, setWorkerDraft] = useState<WorkerDraft>(DEFAULT_WORKER_DRAFT);
  const [detail, setDetail] = useState<DemandDetail | null>(null);
  const [activeDemandId, setActiveDemandId] = useState<string | null>(null);
  const [newDemand, setNewDemand] = useState("");
  const [clarificationReply, setClarificationReply] = useState("");
  const [createSubmitting, setCreateSubmitting] = useState(false);
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

  type ActionRequiredKind = "decision" | "alignment" | "blocked";
  type ActionRequiredEntry = {
    demand: Demand;
    kind: ActionRequiredKind;
    label: string;
    hint: string;
  };

  const actionRequiredEntries: ActionRequiredEntry[] = demands
    .map<ActionRequiredEntry | null>((demand) => {
      if (demand.state === "PENDING_DECISION" || demand.active_decision_id) {
        return {
          demand,
          kind: "decision",
          label: "Decision",
          hint: "Awaiting your decision"
        };
      }
      if (demand.state === "BLOCKED") {
        return {
          demand,
          kind: "blocked",
          label: "Blocked",
          hint: "Execution is blocked, intervention required"
        };
      }
      if (demand.state === "PENDING_ALIGNMENT" || demand.metadata?.clarification_question) {
        return {
          demand,
          kind: "alignment",
          label: "Clarify",
          hint: "Clarification reply needed"
        };
      }
      return null;
    })
    .filter((entry): entry is ActionRequiredEntry => entry !== null);

  const actionRequiredCount = actionRequiredEntries.length;
  const runningExecutionCount = detail?.executions.filter((item) => item.state === "RUNNING" || item.latest_worker_status === "running").length ?? 0;
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

  const workerTiles: WorkerTile[] = (() => {
    const configured = workers.map((worker) => ({
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

    // 占位卡只保留 Codex 和 Claude Code 两种（review 反馈：只留 claude 和 codex，去掉 OpenClaw）。
    // 如果用户已经配置了同名 worker，下面的 filter 会自动隐藏占位卡。
    const placeholders: WorkerTile[] = [
      {
        key: "placeholder-claude-code",
        name: "Claude Code",
        subtitle: "Not configured",
        capabilities: ["Code review", "Refactor", "Patch planning"],
        lamp: "offline"
      },
      {
        key: "placeholder-codex",
        name: "Codex",
        subtitle: "Not configured",
        capabilities: ["Code generation", "Editing", "Command execution"],
        lamp: "offline"
      }
    ];

    const existingNames = new Set(configured.map((item) => item.name.toLowerCase()));
    return [
      ...configured,
      ...placeholders.filter((item) => !existingNames.has(item.name.toLowerCase()))
    ];
  })();

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
      window.alert(error instanceof Error ? error.message : "Failed to register worker");
    } finally {
      setWorkerSubmitting(false);
    }
  }

  /**
   * 重命名 worker —— 弹 prompt 让用户输入新名字，PATCH 后刷新列表。
   * 工作量小的"编辑"路径，避免做完整 edit 表单。
   */
  async function renameWorker(workerId: string, currentName: string) {
    const input = window.prompt("修改 worker 名称（不影响 adapter 配置）：", currentName);
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
      window.alert(error instanceof Error ? error.message : "重命名失败");
    }
  }

  /**
   * 删除 worker —— 后端会拒绝带活跃 execution 的删除（409），UI 把原因报给用户。
   * 成功后从前端 workers 列表移除即可，下次 ws workers broadcast 会再次校准。
   */
  async function deleteWorker(workerId: string, displayName: string) {
    if (!window.confirm(`删除 worker "${displayName}"？`)) return;
    try {
      await apiRequest<void>(`/workers/${workerId}`, { method: "DELETE" });
      setWorkers((current) => current.filter((w) => w.worker_id !== workerId));
    } catch (error) {
      const msg = error instanceof Error ? error.message : "删除失败";
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
      return { tone: "success", progress: 72, done: false };
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

  function demandLampTone(demand: Demand): "success" | "warning" | "danger" | "neutral" {
    if (demand.state === "COMPLETED") {
      return "success";
    }
    if (["FAILED", "CANCELLED"].includes(demand.state)) {
      return "danger";
    }
    if (["PENDING_ALIGNMENT", "PENDING_DECISION", "PAUSED"].includes(demand.state)) {
      return "warning";
    }
    if (["ACTIVE", "READY"].includes(demand.state)) {
      return "success";
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
      return "Queued";
    }
    return {
      waiting: "Waiting",
      ready: "Ready",
      running: "Running",
      success: "Succeeded",
      failed: "Failed"
    }[stage];
  }

  function decisionActionLabel(action: string, reasonCode?: string | null): string {
    if (reasonCode === "PLAN_REVIEW") {
      const planReviewLabels: Record<string, string> = {
        Approve: "Approve Plan",
        ProvideInfo: "Send Feedback",
        Reject: "Reject Plan",
        CancelDemand: "Cancel Demand",
        Pause: "Pause",
        Stop: "Stop"
      };
      if (planReviewLabels[action]) {
        return planReviewLabels[action];
      }
    }
    return {
      Approve: "Approve",
      Reject: "Reject",
      ProvideInfo: "Reply",
      Pause: "Pause",
      Stop: "Stop",
      CancelDemand: "Cancel Demand"
    }[action] ?? action;
  }

  function decisionReasonLabel(reasonCode?: string | null): string {
    if (!reasonCode) return "DECISION";
    const friendly: Record<string, string> = {
      PLAN_REVIEW: "Plan Review",
      PATH_GRANT_REQUIRED: "Path Authorization",
      MISSING_INFO: "Missing Info",
      MISSING_PERMISSION: "Missing Permission",
      INSTALL_REQUIRES_REVIEW: "Install Review",
      PLAN_CONFLICT: "Plan Conflict",
      UNVERIFIABLE_RESULT: "Unverifiable",
      HIGH_RISK_ACTION: "High Risk",
      BLOCKED: "Blocked",
      OPS_ALERT: "Ops Alert"
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

      pushText("当前情况", parsed.decision_prompt);
      pushText("解释", parsed.explanation);
      pushText("原因", parsed.reason);
      pushText("上下文", parsed.context);
      pushText("需要你处理", parsed.human_input_required);
      pushText("为什么需要你介入", parsed.why_human_input_required);
      pushText("建议", parsed.suggestion);
      pushText("下一步建议", parsed.next_step);
      pushList("建议你现在做的事", parsed.suggestions);
      pushList("建议步骤", parsed.next_steps);
      pushList("我还需要确认", parsed.questions);

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
      || "No detail was recorded.";
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
      window.alert(error instanceof Error ? error.message : "Failed to create demand");
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
      window.alert(error instanceof Error ? error.message : "Failed to control demand");
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
      window.alert(error instanceof Error ? error.message : "Failed to interrupt execution");
    } finally {
      setControlSubmittingId(null);
    }
  }

  async function sendClarificationReply() {
    if (!detail || !clarificationReply.trim()) {
      return;
    }

    const replyText = clarificationReply.trim();
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
      window.alert(error instanceof Error ? error.message : "Failed to send clarification reply");
    } finally {
      setReplySubmitting(false);
      setAssistantTyping(false);
      setConversationPending([]);
    }
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
      setSettingsStatus("Settings saved");
    } catch (error) {
      setSettingsStatus(error instanceof Error ? error.message : "Failed to save settings");
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
      window.alert(error instanceof Error ? error.message : "Failed to respond to decision");
    } finally {
      setDecisionSubmitting(null);
    }
  }

  async function requestReplan() {
    if (!detail) {
      return;
    }
    const note = window.prompt(
      "用一句话告诉 planner 为什么要重规划（可选，直接回车跳过）",
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
      window.alert(error instanceof Error ? error.message : "Replan 失败");
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
          {submitting ? "Sending..." : "Approve Once"}
        </button>,
        <button
          key={`${decision.decision_id}-approve-remember`}
          type="button"
          className="primary"
          disabled={submitting}
          onClick={() => void respondToDecision(decision.decision_id, "Approve" as DecisionAction, { remember: true })}
        >
          {submitting ? "Sending..." : "Approve & Remember"}
        </button>,
        <button
          key={`${decision.decision_id}-reject`}
          type="button"
          className="ghost-button danger-button"
          disabled={submitting}
          onClick={() => void respondToDecision(decision.decision_id, "Reject" as DecisionAction)}
        >
          {submitting ? "Sending..." : "Reject"}
        </button>
        // PATH_GRANT 决策原本有 "Cancel Demand" 按钮（DecisionAction.CANCEL_DEMAND）—— 前端按
        // review #6 要求不再展示。后端 API 仍接受 CancelDemand action，需要时可通过其它途径触发。
      ];
    }

    // 通用决策按钮：剔除 CancelDemand，按 review #6 不在前端暴露这个动作
    const actions = ((decision.options?.length ? decision.options : ["ProvideInfo"]) as DecisionAction[])
      .filter((action) => action !== "CancelDemand");
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
          {decisionSubmitting === decision.decision_id ? "Sending..." : decisionActionLabel(action, decision.reason_code)}
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
    if (!window.confirm(`永久删除 demand "${displayName}"？\n（同时清除它的所有 subgoal / execution / decision / memory / events 记录，不可恢复）`)) {
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
      window.alert(error instanceof Error ? error.message : "删除失败");
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
    ? "LLM replying"
    : createSubmitting
      ? "Creating demand"
      : detailLoading
        ? "Loading demand"
        : settingsSaving
          ? "Saving settings"
          : decisionSubmitting
            ? "Submitting decision"
            : controlSubmittingId
              ? "Sending control"
              : workerSubmitting
                ? "Registering worker"
                : dashboardLoading
                  ? "Syncing"
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
      window.alert("请输入以 / 开头的绝对路径");
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
          <div className="brand">
            <span className="brand-mark" aria-hidden="true" />
            <span className="brand-name">NODIKT</span>
            <span className="brand-copy">Intent OS v1</span>
          </div>
        </div>
        {globalBusyLabel ? <div className="global-busy">{globalBusyLabel}<span className="typing-dots"><span>.</span><span>.</span><span>.</span></span></div> : null}
        <nav className="tabs">
          {(["Dashboard", "Workers", "Settings"] as const).map((item) => (
            <button
              key={item}
              className={tab === item ? "tab active" : "tab"}
              onClick={() => setTab(item)}
            >
              {item}
              {item === "Dashboard" && actionRequiredCount > 0 ? (
                <span className="tab-action-badge" aria-label={`${actionRequiredCount} actions required`}>
                  {actionRequiredCount}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
      </header>

      {actionRequiredCount > 0 && (
        <div className="action-required-bar" role="alert">
          <div className="action-required-bar-left">
            <span className="action-required-pulse" aria-hidden="true" />
            <div className="action-required-copy">
              <strong>Action required</strong>
              <span>
                {actionRequiredCount} demand{actionRequiredCount === 1 ? "" : "s"} need{actionRequiredCount === 1 ? "s" : ""} your input
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
                  <h3>Demands</h3>
                  <p className="sidebar-meta">{activeDemandCount} active · {completedDemandCount} completed</p>
                </div>
                <button className="sidebar-plus" onClick={openCreateDemandPanel} title="New Demand">
                  +
                </button>
              </div>
              <button className="sidebar-back" onClick={returnToBoard}>
                Back to board
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
                        <small>{demand.current_phase}</small>
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
                        title="删除此 demand"
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
	                              title="删除此 demand"
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
                            <span className="dashboard-card-label">Subgoal</span>
                            <p className="dashboard-card-subgoal">{demand.dashboard_summary?.current_subgoal_title ?? "Waiting for subgoal"}</p>
                          </div>
                          <div className="dashboard-card-footer">
                            <small>{demand.dashboard_summary?.worker_count ?? 0} worker{(demand.dashboard_summary?.worker_count ?? 0) === 1 ? "" : "s"}</small>
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
                      <strong>Create Demand</strong>
                      <p>Open a new demand and start clarification.</p>
                    </button>
                  </div>
                </div>
              )}

              {dashboardView === "detail" && (!detail || detail.demand.demand_id !== activeDemandId) && detailLoading && (
                <div className="detail-stack detail-stack-loading">
                  <section className="detail-hero detail-section section-a detail-hero-loading">
                    <div className="detail-hero-copy">
                      <div className="detail-hero-heading">
                        <span className="detail-label">Demand</span>
                        <h1>Opening demand...</h1>
                      </div>
                      <p className="detail-summary">Loading the demand state, alignment result, and latest planning snapshot.</p>
                    </div>
                  </section>
                  <div className="detail-grid detail-grid-plan-only">
                    <section className="panel detail-section section-b plan-panel plan-panel-loading">
                      <div className="panel-heading">
                        <div>
                          <p className="eyebrow">Planner View</p>
                          <h2>Plan</h2>
                        </div>
                        <span className="status-chip">Loading</span>
                      </div>
                      <div className="plan-loading-state">
                        <div className="typing-dots"><span>.</span><span>.</span><span>.</span></div>
                        <p>Preparing the demand detail view.</p>
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
                        <span className="detail-label">Demand</span>
                        <h1>{displayDemandTitle(detail.demand)}</h1>
                      </div>
                      <p className="detail-summary">{detail.demand.clarified_demand ?? detail.demand.initial_input}</p>
                    </div>
                    <div className="detail-hero-side">
                      <div className="detail-mini-stats">
                        <div className={`detail-mini-stat detail-mini-stat-${stateTone(detail.demand.state)}`}>
                          <span>Status</span>
                          <strong>{detail.demand.state}</strong>
                        </div>
                        <div className="detail-mini-stat">
                          <span>Phase</span>
                          <strong>{detail.demand.current_phase}</strong>
                        </div>
                        <div className="detail-mini-stat">
                          <span>Running</span>
                          <strong>{runningExecutionCount}</strong>
                        </div>
                        <div className="detail-mini-stat">
                          <span>Decisions</span>
                          <strong>{openDecisionCount}</strong>
                        </div>
	                      </div>
	                      <div className="detail-hero-actions">
	                        {detail.demand.state === "PAUSED" ? (
	                          <button
	                            type="button"
	                            className="primary"
	                            disabled={controlSubmittingId === detail.demand.demand_id}
	                            onClick={() => void controlDemand(detail.demand.demand_id, "resume", "Resumed from demand detail")}
	                          >
	                            Resume
	                          </button>
	                        ) : (
	                          <button
	                            type="button"
	                            className="ghost-button"
	                            disabled={controlSubmittingId === detail.demand.demand_id || ["COMPLETED", "FAILED", "CANCELLED"].includes(detail.demand.state)}
	                            onClick={() => void controlDemand(detail.demand.demand_id, "pause", "Paused from demand detail")}
	                          >
	                            Pause
	                          </button>
	                        )}
	                        <button
	                          type="button"
	                          className="ghost-button interrupt-button"
	                          title="Interrupt all currently running executions but keep the demand active"
	                          disabled={
	                            controlSubmittingId === detail.demand.demand_id ||
	                            runningExecutionCount === 0 ||
	                            ["COMPLETED", "FAILED", "CANCELLED", "PAUSED"].includes(detail.demand.state)
	                          }
	                          onClick={() => {
	                            const note = window.prompt(
	                              `Interrupt ${runningExecutionCount} running execution${runningExecutionCount === 1 ? "" : "s"}? Optionally describe what you want to redirect to (this becomes the interrupt note).`,
	                              ""
	                            );
	                            if (note === null) {
	                              return;
	                            }
	                            void controlDemand(detail.demand.demand_id, "interrupt", note.trim() || "Interrupted from demand detail");
	                          }}
	                        >
	                          {controlSubmittingId === detail.demand.demand_id
	                            ? "Sending..."
	                            : `Interrupt${runningExecutionCount > 0 ? ` (${runningExecutionCount})` : ""}`}
	                        </button>
	                        {/* 详情页头部原 "Cancel Demand" 按钮按 review #6 隐藏（后端 controlDemand cancel API 仍保留）。 */}
	                      </div>
	                    </div>
	                  </section>

	                  {/* 调试信息折叠组：Backend State Record + Plan Evolution。
	                      Runtime Session 按 review 反馈整体从前端去掉（后端日志里仍记录），
	                      避免给客户看 Phase / Frontier / Checkpoint 这种内部状态机字段。 */}
	                  <details className="debug-fold">
	                    <summary className="debug-fold-summary">
	                      <span className="debug-fold-icon" aria-hidden="true">🛠</span>
	                      <span>调试信息（后台记录 / 计划演化）</span>
	                      <small className="debug-fold-hint">点开查看 · 仅供开发者排查</small>
	                    </summary>
	                  <section className="panel detail-section state-record-panel">
	                    <div className="panel-heading">
	                      <div>
	                        <p className="eyebrow">Backend State Record</p>
	                        <h2>Objective, Criteria, Memory</h2>
	                      </div>
	                      <span className="status-chip">{detail.memory.length} memory records</span>
	                    </div>
                      <div className="state-record-grid">
                        <article className="state-record-card">
                          <small>Operational Objective</small>
                          <p className="bounded-copy">
                            {detail.demand.operational_objective?.objective
                              ?? detail.demand.clarified_demand
                              ?? detail.demand.initial_input}
                          </p>
                        </article>
                        <article className="state-record-card">
                          <small>Acceptance Criteria</small>
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
                          ) : <p className="bounded-copy">No acceptance criteria recorded yet.</p>}
                        </article>
                        <article className="state-record-card">
                          <small>Constraints</small>
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
                          ) : <p className="bounded-copy">No constraints recorded yet.</p>}
                        </article>
                        <article className="state-record-card">
                          <small>Memory</small>
                          {detail.memory.length ? (
                            <div className="memory-list">
                              {detail.memory.map((item) => (
                                <div key={item.memory_id} className="memory-item">
                                  <span>{item.category}</span>
                                  <p>{item.content}</p>
                                </div>
                              ))}
                            </div>
                          ) : <p className="bounded-copy">No memory has been written for this demand.</p>}
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
	                            <p className="eyebrow">Plan Evolution</p>
	                            <h2>Round {Math.max(planningRound, 1)} · refined from worker feedback</h2>
	                          </div>
	                          <span className={`status-chip ${planningRound > 1 ? "status-chip-info" : ""}`}>
	                            {planningRound > 1 ? `${planningRound} planning rounds` : "initial plan"}
	                          </span>
	                        </div>
	                        <p className="bounded-copy plan-evolution-intro">
	                          The plan is not frozen up-front. Each subgoal is dispatched, observed, and the next batch is shaped by what we just learned from workers.
	                        </p>
	                        <div className="plan-evolution-grid">
	                          <article className="plan-evolution-card">
	                            <small>What we have done</small>
	                            {traceSummary ? (
	                              <p className="bounded-copy">{traceSummary}</p>
	                            ) : traceMemory.length ? (
	                              <ul className="compact-list">
	                                {traceMemory.slice(-4).map((item) => (
	                                  <li key={item.memory_id}>{item.content}</li>
	                                ))}
	                              </ul>
	                            ) : (
	                              <p className="bounded-copy">No execution trace recorded yet.</p>
	                            )}
	                          </article>
	                          <article className="plan-evolution-card">
	                            <small>What we learned</small>
	                            {lessonsSummary ? (
	                              <p className="bounded-copy">{lessonsSummary}</p>
	                            ) : lessonsMemory.length ? (
	                              <ul className="compact-list">
	                                {lessonsMemory.slice(-4).map((item) => (
	                                  <li key={item.memory_id}>{item.content}</li>
	                                ))}
	                              </ul>
	                            ) : (
	                              <p className="bounded-copy">No lessons captured yet. The next round will absorb feedback once available.</p>
	                            )}
	                          </article>
	                          <article className="plan-evolution-card plan-evolution-card-wide">
	                            <small>Recent worker feedback shaping the next subgoal</small>
	                            {blockerEvents.length ? (
	                              <ul className="plan-evolution-feedback">
	                                {blockerEvents.map((result, idx) => (
	                                  <li key={`${result.execution_id}-${idx}`}>
	                                    <span className="pill pill-warning">{result.blocker_reason?.code ?? "feedback"}</span>
	                                    <p className="bounded-copy">{result.blocker_reason?.message}</p>
	                                    {result.suggested_next_step ? (
	                                      <small>Next step suggested: {result.suggested_next_step}</small>
	                                    ) : null}
	                                  </li>
	                                ))}
	                              </ul>
	                            ) : (
	                              <p className="bounded-copy">No worker blockers yet — boundaries will be tightened as practical feedback arrives.</p>
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
	                          <p className="eyebrow">Human Decision Panel</p>
	                          <h2>{openDecisions.length} action required</h2>
	                        </div>
	                        <span className="status-chip status-chip-warning">waiting on you</span>
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
	                              <small>{decision.source ?? "scheduler"}</small>
	                            </div>
	                            <p className="bounded-copy decision-copy">{summarizeDecisionPrompt(decision.prompt)}</p>
	                            <label className="field">
	                              <span>Reply / extra context</span>
	                              <textarea
	                                value={decisionNoteFor(decision.decision_id)}
	                                onChange={(event) => updateDecisionNote(decision.decision_id, event.target.value)}
	                                placeholder="Provide missing context or instructions when the selected action needs it"
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

	                  <div className="detail-grid detail-grid-plan-only">
                    <section className="panel detail-section section-b plan-panel">
                      <div className="panel-heading">
                        <div>
                          <p className="eyebrow">Planner View</p>
                          <h2>
                            Plan
                            {(latestPlan?.planning_round ?? 0) > 1 ? (
                              <span className="plan-round-badge">v{latestPlan?.planning_round}</span>
                            ) : null}
                          </h2>
                          <small className="plan-subnote">Progressive: each subgoal is shaped by the previous worker feedback.</small>
                        </div>
                        <div className="plan-heading-actions">
                          {/* Replan 按钮按 review 反馈从前端去掉。后端 requestReplan API 仍保留，
                              通过 DECISION_RESPONSE_RECEIVED(action=ProvideInfo, note 含 "replan") 触发。 */}
                          <span className="status-chip">{detail.subgoals.length} subgoals</span>
                        </div>
                      </div>
                      <div className={`plan-scroll${planIsExiting ? " is-replan-exiting" : ""}${planIsTransitioning ? " is-replanning" : ""}`}>
                        {alignmentInProgress ? (
                          <div className="plan-waiting-state">
                            <div className="plan-waiting-head">
                              <div>
                                <p className="eyebrow">Alignment</p>
                                <h3>Clarifying demand before planning</h3>
                              </div>
                              <span className="status-chip status-chip-warning">Waiting for clear scope</span>
                            </div>
                            <p className="bounded-copy">
                              Nodikt is still aligning the demand. Once the objective is clear enough, this panel will transition into the execution plan automatically.
                            </p>
                            <div className="conversation-scroll modal-conversation-scroll detail-conversation-scroll">
                              {conversationHistory.map((message, index) => {
                                const isReconFindings = message.role === "assistant" && message.content.startsWith("[Recon findings]");
                                const displayContent = isReconFindings
                                  ? message.content.replace(/^\[Recon findings\]\s*/, "")
                                  : message.content;
                                const label = isReconFindings
                                  ? "Recon Findings"
                                  : message.role === "assistant" ? "Assistant" : "You";
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
                                  <small>Assistant</small>
                                  <div className="typing-dots"><span>.</span><span>.</span><span>.</span></div>
                                </div>
                              ) : null}
                              <div ref={conversationEndRef} />
                            </div>
                            {detail.demand.metadata?.clarification_question ? (
                              <>
                                <label className="field">
                                  <span>Clarification Reply</span>
                                  <textarea
                                    value={clarificationReply}
                                    onChange={(event) => setClarificationReply(event.target.value)}
                                    placeholder="Answer with the missing repository path, workspace root, or other required execution context"
                                  />
                                </label>
                                <div className="modal-actions">
                                  <button className="primary" disabled={replySubmitting || !clarificationReply.trim()} onClick={sendClarificationReply}>
                                    {replySubmitting ? "Sending..." : "Send Clarification Reply"}
                                  </button>
                                </div>
                              </>
                            ) : (
                              <div className="plan-loading-inline">
                                <div className="typing-dots"><span>.</span><span>.</span><span>.</span></div>
                                <p>Waiting for the next alignment turn.</p>
                              </div>
                            )}
                          </div>
                        ) : planIsGenerating ? (
                          <div className="plan-loading-state plan-loading-state-replan">
                            <div className="plan-waiting-head">
                              <div>
                                <p className="eyebrow">Planning</p>
                                <h3>{planIsTransitioning ? "Replanning execution flow" : "Generating overall plan"}</h3>
                              </div>
                              <span className="status-chip status-chip-info">Planning in progress</span>
                            </div>
                            <p className="bounded-copy">
                              {planIsTransitioning
                                ? "Refreshing the execution plan with your latest instruction. Existing steps are being replaced with a new planning pass."
                                : "The planner is breaking this demand into executable steps and frontier subgoals. The plan cards will fade in here once the first round is ready."}
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
                              <p>Thinking through execution structure</p>
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
                                            : "Unassigned";
                                          const stage = subgoalStage(subgoal.state, execution, linkedDecision);
                                          const inspectable = hasInspectableIssue(stage, linkedDecision);

                                          return (
                                            <div key={subgoal.subgoal_id} className={`plan-subgoal-card plan-subgoal-grid${subgoal.kind === "recon" ? " plan-subgoal-card-recon" : ""}`}>
                                              <div className="subgoal-zone subgoal-zone-main">
                                                <strong>
                                                  {subgoal.title}
                                                  {subgoal.kind === "recon" ? (
                                                    <span className="subgoal-kind-badge subgoal-kind-recon" title="Reconnaissance subgoal: read-only inspection to gather info for the next planning round">RECON</span>
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
                                                <small>Assigned Worker</small>
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
                                                      title="Interrupt this execution"
                                                      disabled={controlSubmittingId === execution.execution_id}
                                                      onClick={(event) => {
                                                        event.stopPropagation();
                                                        if (!window.confirm(`Interrupt subgoal "${subgoal.title}"? The worker will stop and the subgoal will be marked blocked so you can redirect.`)) {
                                                          return;
                                                        }
                                                        void interruptExecution(execution.execution_id, detail.demand.demand_id, `Interrupted subgoal: ${subgoal.title}`);
                                                      }}
                                                    >
                                                      {controlSubmittingId === execution.execution_id ? "..." : "Interrupt"}
                                                    </button>
                                                  ) : null}
                                                </div>
                                              </div>
                                          );
                                        }) : <p className="bounded-copy">No frontier subgoals are attached to this plan item yet.</p>}
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
                                    <p className="eyebrow">Execution Frontier</p>
                                    <h2>Subgoals</h2>
                                  </div>
                                </div>
                                <div className="list-stack plan-subgoal-stack">
                                  {detail.subgoals.map((subgoal) => {
                                    const execution = executionBySubgoalId.get(subgoal.subgoal_id);
                                    const linkedDecision = latestDecisionBySubgoalId.get(subgoal.subgoal_id);
                                    const assignedWorkerId = assignedWorkerBySubgoalId.get(subgoal.subgoal_id);
                                    const assignedWorkerLabel = assignedWorkerId
                                      ? (workerNameById.get(assignedWorkerId) ?? assignedWorkerId)
                                      : "Unassigned";
                                    const stage = subgoalStage(subgoal.state, execution, linkedDecision);
                                    const inspectable = hasInspectableIssue(stage, linkedDecision);

                                    return (
                                      <div key={subgoal.subgoal_id} className={`plan-subgoal-card plan-subgoal-grid${subgoal.kind === "recon" ? " plan-subgoal-card-recon" : ""}`}>
                                        <div className="subgoal-zone subgoal-zone-main">
                                          <strong>
                                            {subgoal.title}
                                            {subgoal.kind === "recon" ? (
                                              <span className="subgoal-kind-badge subgoal-kind-recon" title="Reconnaissance subgoal: read-only inspection to gather info for the next planning round">RECON</span>
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
                                          <small>Assigned Worker</small>
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
                                              title="Interrupt this execution"
                                              disabled={controlSubmittingId === execution.execution_id}
                                              onClick={(event) => {
                                                event.stopPropagation();
                                                if (!window.confirm(`Interrupt subgoal "${subgoal.title}"? The worker will stop and the subgoal will be marked blocked so you can redirect.`)) {
                                                  return;
                                                }
                                                void interruptExecution(execution.execution_id, detail.demand.demand_id, `Interrupted subgoal: ${subgoal.title}`);
                                              }}
                                            >
                                              {controlSubmittingId === execution.execution_id ? "..." : "Interrupt"}
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
                  <div className="create-modal" onClick={(event) => event.stopPropagation()}>
                    <div className="panel-heading">
                      <div>
                        <p className="eyebrow">{detail && demandNeedsClarification(detail.demand) ? "Alignment" : "New Demand"}</p>
                        <h2>{detail && demandNeedsClarification(detail.demand) ? "Clarify Demand" : "Create Demand"}</h2>
                      </div>
                      <button className="ghost-button" onClick={closeCreateModal}>Close</button>
                    </div>
                    {detail && demandNeedsClarification(detail.demand) ? (
                      <div className="alignment-modal-body">
                        <p className="bounded-copy">
                          Stay in alignment until the demand is clear. Once clarification is complete, Nodikt will enter the demand page and show the execution plan.
                        </p>
                        <div className="conversation-scroll modal-conversation-scroll">
                          {conversationHistory.map((message, index) => {
                            const isReconFindings = message.role === "assistant" && message.content.startsWith("[Recon findings]");
                            const displayContent = isReconFindings
                              ? message.content.replace(/^\[Recon findings\]\s*/, "")
                              : message.content;
                            const label = isReconFindings
                              ? "Recon Findings"
                              : message.role === "assistant" ? "Assistant" : "You";
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
                              <small>Assistant</small>
                              <div className="typing-dots"><span>.</span><span>.</span><span>.</span></div>
                            </div>
                          ) : null}
                        </div>
                        {detail.demand.metadata?.clarification_question ? (
                          <>
                            <label className="field">
                              <span>Clarification Reply</span>
                              <textarea
                                value={clarificationReply}
                                onChange={(event) => setClarificationReply(event.target.value)}
                                placeholder="Answer with the missing repository path, workspace root, or other required execution context"
                              />
                            </label>
                            <div className="modal-actions">
                              <button className="ghost-button" onClick={closeCreateModal}>Cancel</button>
                              <button className="primary" disabled={replySubmitting || !clarificationReply.trim()} onClick={sendClarificationReply}>{replySubmitting ? "Sending..." : "Send Clarification Reply"}</button>
                            </div>
                          </>
                        ) : (
                          <p className="bounded-copy">Waiting for the next clarification turn.</p>
                        )}
                      </div>
                    ) : (
                      <>
                        <p className="bounded-copy">
                          Start with the demand in natural language. Nodikt will open the detail view immediately and stream alignment and planning progress there.
                        </p>
                        <textarea
                          value={newDemand}
                          onChange={(event) => setNewDemand(event.target.value)}
                          placeholder="Describe the demand, expected output, project path, and key constraints"
                        />
                        <div className="modal-actions">
                          <button className="ghost-button" onClick={closeCreateModal}>Cancel</button>
                          <button className="primary" disabled={createSubmitting || !newDemand.trim()} onClick={createDemand}>{createSubmitting ? "Creating..." : "Create Demand"}</button>
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
                        <p className="eyebrow">Subgoal Detail</p>
                        <h2>{selectedDialogSubgoal.title}</h2>
                      </div>
                      <button className="ghost-button" type="button" onClick={closeSubgoalDialog}>
                        Close
                      </button>
                    </div>
                    {selectedSubgoalDialog.mode === "success" ? (
                      <div className="subgoal-result-stack">
                        <section className="decision-modal-card subgoal-result-card">
                          <div className="decision-modal-head">
                            <small className="pill pill-success">Succeeded</small>
                            {selectedDialogExecution ? <small>{selectedDialogExecution.execution_id}</small> : null}
                          </div>
                          <div className="subgoal-result-block">
                            <span className="subgoal-result-label">Result</span>
                            <pre className="decision-modal-prompt">{selectedDialogExecution?.claimed_outcome || selectedDialogExecution?.compressed_history || "No result text was captured."}</pre>
                          </div>
                          <div className="subgoal-result-block">
                            <span className="subgoal-result-label">Artifacts</span>
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
                              <p className="bounded-copy">No artifacts were recorded for this subgoal.</p>
                            )}
                          </div>
                        </section>
                      </div>
                    ) : (
                      <div className="subgoal-result-stack">
                        <section className="decision-modal-card subgoal-result-card">
                          <div className="decision-modal-head">
                            <small className={`pill ${selectedSubgoalDialog.mode === "failed" ? "pill-danger" : "pill-warning"}`}>
                              {selectedSubgoalDialog.mode === "failed" ? "Failed" : "Pending"}
                            </small>
                            {selectedDialogDecision?.reason_code ? <small>{selectedDialogDecision.reason_code}</small> : null}
                          </div>
                          <div className="subgoal-result-block">
                            <span className="subgoal-result-label">
                              {selectedSubgoalDialog.mode === "failed" ? "Failure Detail" : "Decision Detail"}
                            </span>
                            <pre className="decision-modal-prompt">
                              {selectedDialogWorkerResult?.blocker_reason?.message
                                || rawSubgoalIssueText(selectedDialogExecution, selectedDialogWorkerResult, selectedDialogDecision)
                                || selectedDialogExecution?.claimed_outcome
                                || selectedDialogExecution?.compressed_history
                                || "No detail was recorded."}
                            </pre>
                          </div>
                          <div className="subgoal-result-block">
                            <span className="subgoal-result-label">Reason</span>
                            <p className="bounded-copy">
                              {selectedDialogDecision?.reason_code
                                || selectedDialogExecution?.result_status
                                || selectedDialogExecution?.state
                                || "Unknown"}
                            </p>
                          </div>
                        </section>
                        <section className="decision-modal-card subgoal-result-card">
                          <div className="decision-modal-head">
                            <small className="pill pill-warning">Suggestions</small>
                          </div>
                          <div className="suggestion-dialogue">
                            {selectedDecisionConversation.length ? (
                              selectedDecisionConversation.map((message, index) => (
                                <div
                                  key={`${message.created_at}-${index}`}
                                  className={`conversation-turn ${message.role === "assistant" ? "assistant" : "user"} suggestion-turn`}
                                >
                                  <small>{message.role === "assistant" ? "故障助手" : "你"}</small>
                                  {message.role === "assistant" ? (
                                    <p className="suggestion-message">{summarizeDecisionPrompt(message.content)}</p>
                                  ) : (
                                    <p>{message.content}</p>
                                  )}
                                </div>
                              ))
                            ) : (
                              <div className="conversation-turn assistant suggestion-turn">
                                <small>故障助手</small>
                                <p className="suggestion-message">
                                  {summarizeDecisionPrompt(selectedDialogDecision?.prompt ?? "I can help you understand this failure and suggest the next unblock step.")}
                                </p>
                              </div>
                            )}
                            {decisionSubmitting === selectedDialogDecision?.decision_id ? (
                              <div className="conversation-turn assistant suggestion-turn conversation-turn-typing">
                                <small>故障助手</small>
                                <div className="typing-dots"><span>.</span><span>.</span><span>.</span></div>
                              </div>
                            ) : null}
                          </div>
                          {selectedDialogDecision ? (
                            <>
                              <label className="field">
                                <span>Reply</span>
                                <textarea
                                  value={decisionNoteFor(selectedDialogDecision.decision_id)}
                                  onChange={(event) => updateDecisionNote(selectedDialogDecision.decision_id, event.target.value)}
                                  placeholder="Reply to this failed subgoal and provide the next instruction or missing context"
                                />
	                              </label>
	                              <div className="decision-modal-actions">
	                                {renderDecisionActions(selectedDialogDecision)}
	                              </div>
	                            </>
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
                <p className="eyebrow">Worker Fleet</p>
                <h1>Observe runtime capacity and adapter readiness.</h1>
              </div>
              <div className="hero-metrics">
                <div className="metric-card">
                  <span>Total</span>
                  <strong>{workers.length}</strong>
                </div>
                <button type="button" className="metric-card worker-add-card" onClick={() => setShowWorkerCreateModal(true)}>
                  <span>Add</span>
                  <strong>+</strong>
                </button>
              </div>
            </div>
            <div className="worker-tiles">
              {workerTiles.map((worker) => {
                // placeholder 卡片不暴露编辑 / 删除 / 详情（它对应的真实 worker 还没创建）
                const isPlaceholder = worker.key.startsWith("placeholder-");
                return (
                  <div
                    key={worker.key}
                    className={`worker-tile${isPlaceholder ? "" : " worker-tile-clickable"}`}
                    onClick={isPlaceholder ? undefined : () => setSelectedWorkerId(worker.key)}
                    role={isPlaceholder ? undefined : "button"}
                    tabIndex={isPlaceholder ? undefined : 0}
                  >
                    <div className="worker-tile-top">
                      <span className={`worker-lamp worker-lamp-${worker.lamp}`} />
                      <small>{worker.subtitle}</small>
                      {!isPlaceholder && (
                        <div className="worker-tile-actions" onClick={(event) => event.stopPropagation()}>
                          <button
                            type="button"
                            className="worker-tile-action"
                            title="重命名"
                            onClick={() => void renameWorker(worker.key, worker.name)}
                          >
                            ✏️
                          </button>
                          <button
                            type="button"
                            className="worker-tile-action worker-tile-action-danger"
                            title="删除"
                            onClick={() => void deleteWorker(worker.key, worker.name)}
                          >
                            🗑
                          </button>
                        </div>
                      )}
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
                );
              })}
            </div>
            {detail && (
              <div className="worker-grid worker-runtime-grid">
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <p className="eyebrow">Selected Demand Runtime</p>
                      <h2>Worker Runtime</h2>
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
                      <p className="eyebrow">Selected Demand Trace</p>
                      <h2>Recent Events</h2>
                    </div>
                  </div>
                  {hiddenHeartbeatCount > 0 && (
                    <p className="panel-note">已隐藏 {hiddenHeartbeatCount} 条心跳事件，保持时间线清爽。</p>
                  )}
                  <div className="list-stack">
                    {visibleTimelineEvents.map((item) => {
                      const human = humanizeEvent(item);
                      return (
                        <div
                          key={item.event_id}
                          className={`timeline-item timeline-card timeline-tone-${human.tone}`}
                          title={`${item.event_type} @ ${item.created_at}`}
                        >
                          <strong>{human.label}</strong>
                          <small>{formatRelativeShort(item.created_at, Date.now())}</small>
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
        {tab === "Workers" && selectedWorkerId && (() => {
          const w = workers.find((item) => item.worker_id === selectedWorkerId);
          if (!w) return null;
          const cfg = w.config ?? {};
          const envEntries = Object.entries(cfg.env ?? {});
          return (
            <div className="modal-layer" onClick={() => setSelectedWorkerId(null)}>
              <div className="create-modal worker-detail-modal" onClick={(event) => event.stopPropagation()}>
                <div className="panel-heading">
                  <div>
                    <p className="eyebrow">Worker Detail</p>
                    <h2>{w.name}</h2>
                  </div>
                  <button className="ghost-button" onClick={() => setSelectedWorkerId(null)}>Close</button>
                </div>
                <div className="worker-detail-grid">
                  <div className="worker-detail-row">
                    <span>Worker ID</span>
                    <code>{w.worker_id}</code>
                  </div>
                  <div className="worker-detail-row">
                    <span>Adapter</span>
                    <strong>{w.adapter_type}</strong>
                  </div>
                  <div className="worker-detail-row">
                    <span>Runtime</span>
                    <strong>{w.runtime_type ?? "local_command"}</strong>
                  </div>
                  <div className="worker-detail-row">
                    <span>Status</span>
                    <strong>{w.status}</strong>
                  </div>
                  <div className="worker-detail-row">
                    <span>Max Concurrency</span>
                    <strong>{w.max_concurrency ?? "—"}</strong>
                  </div>
                  <div className="worker-detail-row">
                    <span>Active Executions</span>
                    <strong>{w.current_execution_ids?.length ?? 0}</strong>
                  </div>
                  <div className="worker-detail-row">
                    <span>Last Seen</span>
                    <strong>{w.last_seen_at ? formatRelativeShort(w.last_seen_at, Date.now()) : "—"}</strong>
                  </div>
                  {w.last_error ? (
                    <div className="worker-detail-row worker-detail-row-error">
                      <span>Last Error</span>
                      <code>{w.last_error}</code>
                    </div>
                  ) : null}
                  <div className="worker-detail-row">
                    <span>Capabilities</span>
                    <div className="worker-capabilities">
                      {w.capabilities.map((c) => (
                        <span key={c} className="worker-capability-chip">{c}</span>
                      ))}
                    </div>
                  </div>
                  <div className="worker-detail-section">
                    <p className="eyebrow">Adapter Config</p>
                    <div className="worker-detail-config">
                      {cfg.workspace_root ? (
                        <div className="worker-detail-row">
                          <span>workspace_root</span>
                          <code>{cfg.workspace_root}</code>
                        </div>
                      ) : null}
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
                      {cfg.endpoint ? (
                        <div className="worker-detail-row">
                          <span>endpoint</span>
                          <code>{cfg.endpoint}</code>
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
                    className="ghost-button"
                    onClick={() => {
                      setSelectedWorkerId(null);
                      void renameWorker(w.worker_id, w.name);
                    }}
                  >
                    ✏️ 重命名
                  </button>
                  <button
                    type="button"
                    className="ghost-button danger-button"
                    onClick={() => {
                      setSelectedWorkerId(null);
                      void deleteWorker(w.worker_id, w.name);
                    }}
                  >
                    🗑 删除 Worker
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {tab === "Workers" && showWorkerCreateModal && (
          <div className="modal-layer" onClick={() => setShowWorkerCreateModal(false)}>
            <div className="create-modal worker-create-modal" onClick={(event) => event.stopPropagation()}>
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">New Worker</p>
                  <h2>Add Worker</h2>
                </div>
                <button className="ghost-button" onClick={() => setShowWorkerCreateModal(false)}>Close</button>
              </div>
              <p className="bounded-copy">
                Register a backend worker adapter. Dispatch, health, execution, and result collection will follow the backend adapter contract.
              </p>
              <label className="field">
                <span>Name</span>
                <input
                  value={workerDraft.name}
                  onChange={(event) => updateWorkerDraft("name", event.target.value)}
                  placeholder="OpenCode"
                />
              </label>
              <div className="worker-form-grid">
                <label className="field">
                  <span>Adapter</span>
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
                  <span>Runtime</span>
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
                <span>Workspace Root</span>
                <input
                  value={workerDraft.workspace_root}
                  onChange={(event) => updateWorkerDraft("workspace_root", event.target.value)}
                  placeholder={settingsDraft.workspace_root || settings.workspace_root || "/path/to/workspace"}
                />
              </label>
              <label className="field">
                <span>Capabilities</span>
                <input
                  value={workerDraft.capabilities}
                  onChange={(event) => updateWorkerDraft("capabilities", event.target.value)}
                  placeholder="code_generation, file_edit, command_execution"
                />
              </label>
              <div className="worker-form-grid">
                <label className="field">
                  <span>Max Concurrency</span>
                  <input
                    type="number"
                    min="1"
                    value={workerDraft.max_concurrency}
                    onChange={(event) => updateWorkerDraft("max_concurrency", Number(event.target.value))}
                  />
                </label>
                <label className="field">
                  <span>Endpoint</span>
                  <input
                    value={workerDraft.endpoint}
                    onChange={(event) => updateWorkerDraft("endpoint", event.target.value)}
                    placeholder="http/ws endpoint when used"
                  />
                </label>
              </div>
              {workerDraft.adapter_type === "codex" ? (
                <div className="worker-form-grid">
                  <label className="field">
                    <span>Command</span>
                    <input
                      value={workerDraft.command}
                      onChange={(event) => updateWorkerDraft("command", event.target.value)}
                      placeholder="bash"
                    />
                  </label>
                  <label className="field">
                    <span>Args</span>
                    <input
                      value={workerDraft.args}
                      onChange={(event) => updateWorkerDraft("args", event.target.value)}
                      placeholder='["-lc", "codex ..."]'
                    />
                  </label>
                </div>
              ) : null}
              <div className="modal-actions">
                <button className="ghost-button" onClick={() => setShowWorkerCreateModal(false)}>Cancel</button>
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
	                  {workerSubmitting ? "Creating..." : "Create Worker"}
	                </button>
              </div>
            </div>
          </div>
        )}

        {tab === "Settings" && (
          <section className="content single settings-content">
            <div className="panel settings-panel">
              <div className="settings-header">
                <div>
                  <h2>模型设置</h2>
                  <p>填入你常用的大模型 API（默认接入 OpenAI 兼容协议）。Nodikt 会用它做需求澄清、计划生成、结果验证。</p>
                </div>
                <button className="primary" disabled={!settingsDirty || settingsSaving} onClick={saveSettings}>
                  {settingsSaving ? "Saving..." : "Save Settings"}
                </button>
              </div>
              {settingsStatus && <p>{settingsStatus}</p>}

              <label className="field">
                <span>Workspace Root</span>
                <input
                  value={settingsDraft.workspace_root}
                  onChange={(event) => updateWorkspaceRoot(event.target.value)}
                />
              </label>

              <section className="workspace-grants-section">
                <div className="workspace-grants-head">
                  <h3>授权目录</h3>
                  <small>除主工作目录外，worker 还能读写的路径。Demand 指定路径若在此清单或当前 demand 临时授权中，则免询问直接放行；否则弹窗请求授权。</small>
                </div>
                <div className="workspace-grants-list">
                  {((settingsDraft.workspace_grants ?? []) as Array<{ path: string; granted_at: string }>).length === 0 ? (
                    <p className="workspace-grants-empty">还没有授权目录。提需求时若涉及外部路径会自动弹出授权请求；也可以在下方手动添加。</p>
                  ) : (
                    ((settingsDraft.workspace_grants ?? []) as Array<{ path: string; granted_at: string }>).map((grant) => (
                      <div key={grant.path} className="workspace-grant-row">
                        <code>{grant.path}</code>
                        <small className="workspace-grant-meta">
                          {grant.granted_at ? `授权于 ${formatRelativeShort(grant.granted_at, Date.now())}` : ""}
                        </small>
                        <button
                          type="button"
                          className="workspace-grant-remove"
                          title="移除授权"
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
                    placeholder="/path/to/extra/directory"
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
                    + 添加
                  </button>
                </div>
              </section>

              <div className="settings-grid">
                {(Object.keys(settingsDraft.models) as Array<keyof Settings["models"]>).map((role) => {
                  const model = settingsDraft.models[role];
                  return (
                    <section key={role} className="settings-card">
                      <div className="settings-card-header">
                        <h3>{role}</h3>
                        {/* Enable toggle 按 review 反馈移除：模型卡只要存在就视为启用，
                            后端 model.enabled 默认 true；要禁用直接清空 api_key 或换模型。 */}
                      </div>

                      <label className="field">
                        <span>Provider</span>
                        <input
                          value={model.provider}
                          onChange={(event) => updateModel(role, "provider", event.target.value)}
                          placeholder="openai-compatible / anthropic / uniapi"
                        />
                      </label>

                      <label className="field">
                        <span>Model</span>
                        <input
                          value={model.model}
                          onChange={(event) => updateModel(role, "model", event.target.value)}
                          placeholder="gpt-4o-mini / claude / qwen"
                        />
                      </label>

                      <label className="field">
                        <span>Base URL</span>
                        <input
                          value={model.base_url}
                          onChange={(event) => updateModel(role, "base_url", event.target.value)}
                          placeholder="https://api.openai.com/v1"
                        />
                      </label>

                      <label className="field">
                        <span>API Key</span>
                        <input
                          type="password"
                          value={model.api_key}
                          onChange={(event) => updateModel(role, "api_key", event.target.value)}
                          placeholder="sk-..."
                        />
                      </label>
                    </section>
                  );
                })}
              </div>

              <div className="settings-grid">
                <section className="settings-card">
                  <h3>Runtime</h3>
                  <label className="field">
                    <span>Heartbeat Seconds</span>
                    <input
                      type="number"
                      value={settingsDraft.runtime.heartbeat_interval_seconds}
                      onChange={(event) => updateRuntime("heartbeat_interval_seconds", Number(event.target.value))}
                    />
                  </label>
                  <label className="field">
                    <span>Execution Timeout Seconds</span>
                    <input
                      type="number"
                      value={settingsDraft.runtime.execution_timeout_seconds}
                      onChange={(event) => updateRuntime("execution_timeout_seconds", Number(event.target.value))}
                    />
                  </label>
                  <label className="field">
                    <span>Max Retry Count</span>
                    <input
                      type="number"
                      value={settingsDraft.runtime.max_retry_count}
                      onChange={(event) => updateRuntime("max_retry_count", Number(event.target.value))}
                    />
                  </label>
                </section>

                <section className="settings-card">
                  <h3>Current Snapshot</h3>
                  <pre>{JSON.stringify(settings, null, 2)}</pre>
                </section>
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
