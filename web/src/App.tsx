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
  name: "OpenCode",
  adapter_type: "opencode",
  runtime_type: "local_command",
  max_concurrency: 1,
  capabilities: "code_generation, file_edit, command_execution",
  workspace_root: "",
  command: "",
  args: "",
  endpoint: ""
};

export function App() {
  const [tab, setTab] = useState<"Dashboard" | "Workers" | "Settings">("Dashboard");
  const [dashboardView, setDashboardView] = useState<"board" | "detail" | "create">("board");
  const [demands, setDemands] = useState<Demand[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [showWorkerCreateModal, setShowWorkerCreateModal] = useState(false);
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
  const [workerSubmitting, setWorkerSubmitting] = useState(false);
  const boardCardRefs = useRef<Record<string, HTMLElement | null>>({});
  const previousBoardRects = useRef<Map<string, DOMRect>>(new Map());
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const subgoalDialogCloseTimerRef = useRef<number | null>(null);
  const planTransitionTimerRef = useRef<number | null>(null);
  const createSessionRef = useRef(0);
  const detailRequestRef = useRef(0);
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

    const placeholders: WorkerTile[] = [
      {
        key: "placeholder-codex",
        name: "Codex",
        subtitle: "Not configured",
        capabilities: ["Code generation", "Editing", "Command execution"],
        lamp: "offline"
      },
      {
        key: "placeholder-claude-code",
        name: "Claude Code",
        subtitle: "Not configured",
        capabilities: ["Code review", "Refactor", "Patch planning"],
        lamp: "offline"
      },
      {
        key: "placeholder-openclaw",
        name: "OpenClaw",
        subtitle: "Not configured",
        capabilities: ["Automation", "Code execution", "Task handling"],
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
        </button>,
        <button
          key={`${decision.decision_id}-cancel`}
          type="button"
          className="ghost-button danger-button"
          disabled={submitting}
          onClick={() => void respondToDecision(decision.decision_id, "CancelDemand" as DecisionAction)}
        >
          {submitting ? "Sending..." : "Cancel Demand"}
        </button>
      ];
    }

    const actions = (decision.options?.length ? decision.options : ["ProvideInfo"]) as DecisionAction[];
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
    invalidateDemandView({ resetComposer: true });
    setTab("Dashboard");
    setDashboardView("create");
  }

  function returnToBoard() {
    invalidateDemandView();
    setDashboardView("board");
    setSelectedSubgoalDialog(null);
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
                  return (
                    <button
                      key={demand.demand_id}
                      className={detail?.demand.demand_id === demand.demand_id ? "demand-link active" : "demand-link"}
                      onClick={() => loadDemandDetail(demand.demand_id)}
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
                    </button>
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
	                              title="Cancel demand"
	                              disabled={controlSubmittingId === demand.demand_id}
	                              onClick={() => {
	                                setBoardDismissingId(demand.demand_id);
	                                void controlDemand(demand.demand_id, "cancel", "Cancelled from dashboard board");
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
	                        <button
	                          type="button"
	                          className="ghost-button danger-button"
	                          disabled={controlSubmittingId === detail.demand.demand_id || ["COMPLETED", "FAILED", "CANCELLED"].includes(detail.demand.state)}
	                          onClick={() => void controlDemand(detail.demand.demand_id, "cancel", "Cancelled from demand detail", { returnToBoardAfterCancel: true })}
	                        >
	                          {controlSubmittingId === detail.demand.demand_id ? "Sending..." : "Cancel Demand"}
	                        </button>
	                      </div>
	                    </div>
	                  </section>

	                  <section className="panel detail-section runtime-panel">
	                    <div className="panel-heading">
	                      <div>
	                        <p className="eyebrow">Runtime Session</p>
	                        <h2>{runtimeSession?.progress_note ?? "Waiting for scheduler progress"}</h2>
	                      </div>
	                      <span className={`status-chip status-chip-${stateTone(runtimeSession?.waiting_on ? "PENDING_DECISION" : detail.demand.state)}`}>
	                        {runtimeSession?.waiting_on ? `waiting: ${runtimeSession.waiting_on}` : "live"}
	                      </span>
	                    </div>
	                    <div className="runtime-session-grid">
	                      <div>
	                        <span>Phase</span>
	                        <strong>{runtimeSession?.phase ?? detail.demand.current_phase}</strong>
	                      </div>
	                      <div>
	                        <span>Frontier</span>
	                        <strong>{runtimeSession?.frontier_subgoal_ids?.length ?? latestPlan?.frontier_subgoal_ids?.length ?? 0}</strong>
	                      </div>
	                      <div>
	                        <span>Checkpoint</span>
	                        <strong>{runtimeSession?.latest_checkpoint ?? "none"}</strong>
	                      </div>
	                      <div>
	                        <span>Last Progress</span>
	                        <strong>{runtimeSession?.last_progress_at ?? detail.demand.updated_at}</strong>
	                      </div>
	                    </div>
	                  </section>

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
                          <button
                            type="button"
                            className="ghost plan-replan-button"
                            onClick={() => void requestReplan()}
                            disabled={
                              replanSubmitting
                              || planIsTransitioning
                              || alignmentInProgress
                              || ["COMPLETED", "FAILED", "CANCELLED", "PAUSED"].includes(detail.demand.state)
                            }
                            title="重新规划：发起一次新的 planner 调用，把当前 plan 替换为新的方案"
                          >
                            {replanSubmitting ? "Replanning..." : "Replan"}
                          </button>
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
                <div className="modal-layer" onClick={returnToBoard}>
                  <div className="create-modal" onClick={(event) => event.stopPropagation()}>
                    <div className="panel-heading">
                      <div>
                        <p className="eyebrow">{detail && demandNeedsClarification(detail.demand) ? "Alignment" : "New Demand"}</p>
                        <h2>{detail && demandNeedsClarification(detail.demand) ? "Clarify Demand" : "Create Demand"}</h2>
                      </div>
                      <button className="ghost-button" onClick={returnToBoard}>Close</button>
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
                              <button className="ghost-button" onClick={returnToBoard}>Cancel</button>
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
                          <button className="ghost-button" onClick={returnToBoard}>Cancel</button>
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
              {workerTiles.map((worker) => (
                <div key={worker.key} className="worker-tile">
                  <div className="worker-tile-top">
                    <span className={`worker-lamp worker-lamp-${worker.lamp}`} />
                    <small>{worker.subtitle}</small>
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
                    <p className="panel-note">Hidden {hiddenHeartbeatCount} heartbeat events to keep the timeline readable.</p>
                  )}
                  <div className="list-stack">
                    {visibleTimelineEvents.map((item) => (
                      <div key={item.event_id} className="timeline-item timeline-card">
                        <strong>{item.event_type}</strong>
                        <small>{item.created_at}</small>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            )}
          </section>
        )}

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
                    <option value="opencode">opencode</option>
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
                  <h2>LLM Settings</h2>
                  <p>Configure the APIs used for clarification, planning, verifier assistance, and ops backup.</p>
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

              <div className="settings-grid">
                {(Object.keys(settingsDraft.models) as Array<keyof Settings["models"]>).map((role) => {
                  const model = settingsDraft.models[role];
                  return (
                    <section key={role} className="settings-card">
                      <div className="settings-card-header">
                        <h3>{role}</h3>
                        <label className="toggle">
                          <input
                            type="checkbox"
                            checked={model.enabled}
                            onChange={(event) => updateModel(role, "enabled", event.target.checked)}
                          />
                          <span>Enabled</span>
                        </label>
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
