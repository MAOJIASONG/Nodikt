import type { CSSProperties } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

type Demand = {
  demand_id: string;
  title: string;
  state: string;
  current_phase: string;
  clarified_demand: string | null;
  initial_input: string;
  dashboard_summary?: {
    current_subgoal_title?: string | null;
    worker_count?: number;
  };
  metadata?: {
    clarification_question?: string | null;
    conversation_history?: Array<{
      role: "user" | "assistant";
      content: string;
      created_at: string;
    }>;
    latest_plan?: {
      planning_round: number;
      frontier_subgoal_ids: string[];
      overall_plan_outline: Array<{
        plan_item_id: string;
        title: string;
        objective: string;
        execution_mode: "parallel" | "sequential";
        rationale: string;
        frontier_subgoal_ids?: string[];
      }>;
      high_level_summary: {
        mission_state_summary: string;
        episodic_trace_summary: string;
        lessons_or_policy_summary: string;
      };
    };
  };
};

type Worker = {
  worker_id: string;
  name: string;
  adapter_type: string;
  status: string;
  capabilities: string[];
};

type WorkerTile = {
  key: string;
  name: string;
  subtitle: string;
  capabilities: string[];
  lamp: "online" | "offline" | "fault";
};

type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
  created_at: string;
  optimistic?: boolean;
};

type Decision = {
  decision_id: string;
  prompt: string;
  status: string;
  options?: string[];
  reason_code?: string;
  source?: string;
  subgoal_id?: string | null;
  execution_id?: string | null;
  metadata?: {
    conversation_history?: Array<{
      role: "assistant" | "user";
      content: string;
      created_at: string;
    }>;
  };
};

type ArtifactRef = {
  artifact_id: string;
  artifact_type: string;
  uri: string;
};

type Execution = {
  execution_id: string;
  subgoal_id: string;
  worker_id: string;
  state: string;
  latest_worker_status: string | null;
  result_status: string | null;
  claimed_outcome: string | null;
  compressed_history: string;
  artifacts: ArtifactRef[];
  created_at: string;
  updated_at: string;
};

type WorkerResultEventPayload = {
  worker_result?: {
    execution_id: string;
    worker_status?: string | null;
    claimed_outcome?: string | null;
    compressed_history?: string;
    produced_artifacts?: ArtifactRef[];
    blocker_reason?: {
      code?: string;
      message?: string;
    } | null;
    suggested_next_step?: string | null;
  };
};

type DemandEvent = {
  event_id: string;
  event_type: string;
  created_at: string;
  execution_id?: string | null;
  subgoal_id?: string | null;
  payload?: WorkerResultEventPayload | Record<string, unknown>;
};

type DemandDetail = {
  demand: Demand;
  subgoals: Array<{ subgoal_id: string; title: string; state: string; objective: string }>;
  executions: Execution[];
  decisions: Decision[];
  events: DemandEvent[];
  memory: Array<{ memory_id: string; category: string; content: string }>;
};

type ModelConfig = {
  provider: string;
  model: string;
  base_url: string;
  api_key: string;
  enabled: boolean;
};

type Settings = {
  version: "v1";
  updated_at: string;
  models: {
    primary: ModelConfig;
    planner: ModelConfig;
    verifier: ModelConfig;
    ops_backup: ModelConfig;
  };
  workspace_root: string;
  runtime: {
    heartbeat_interval_seconds: number;
    execution_timeout_seconds: number;
    max_retry_count: number;
  };
  worker_policy: {
    skill_install_scope: string;
  };
  default_autonomy_level: string;
  default_permissions: {
    can_modify_files: boolean;
    can_run_commands: boolean;
    can_install_dependencies: boolean;
    can_open_pr: boolean;
  };
};

const API_BASE = `${window.location.origin}/api`;

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

export function App() {
  const [tab, setTab] = useState<"Dashboard" | "Workers" | "Settings">("Dashboard");
  const [dashboardView, setDashboardView] = useState<"board" | "detail" | "create">("board");
  const [demands, setDemands] = useState<Demand[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [localWorkerPaths, setLocalWorkerPaths] = useState<string[]>([]);
  const [showWorkerCreateModal, setShowWorkerCreateModal] = useState(false);
  const [newWorkerPath, setNewWorkerPath] = useState("");
  const [detail, setDetail] = useState<DemandDetail | null>(null);
  const [activeDemandId, setActiveDemandId] = useState<string | null>(null);
  const [newDemand, setNewDemand] = useState("");
  const [clarificationReply, setClarificationReply] = useState("");
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [replySubmitting, setReplySubmitting] = useState(false);
  const [assistantTyping, setAssistantTyping] = useState(false);
  const [deleteSubmittingId, setDeleteSubmittingId] = useState<string | null>(null);
  const [boardDismissingId, setBoardDismissingId] = useState<string | null>(null);
  const [conversationPending, setConversationPending] = useState<ConversationMessage[]>([]);
  const [selectedSubgoalDialog, setSelectedSubgoalDialog] = useState<{ subgoalId: string; mode: "success" | "failed" | "issue" } | null>(null);
  const [subgoalDialogClosing, setSubgoalDialogClosing] = useState(false);
  const [planTransitionMode, setPlanTransitionMode] = useState<"idle" | "exiting" | "replanning">("idle");
  const [decisionNote, setDecisionNote] = useState("");
  const [decisionSubmitting, setDecisionSubmitting] = useState<string | null>(null);
  const [expandedPlanItemId, setExpandedPlanItemId] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(EMPTY_SETTINGS);
  const [settingsDraft, setSettingsDraft] = useState<Settings>(EMPTY_SETTINGS);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsStatus, setSettingsStatus] = useState("");
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
    setDecisionNote("");
  }

  function closeSubgoalDialog() {
    if (!selectedSubgoalDialog || subgoalDialogClosing) {
      return;
    }
    setSubgoalDialogClosing(true);
    subgoalDialogCloseTimerRef.current = window.setTimeout(() => {
      setSelectedSubgoalDialog(null);
      setSubgoalDialogClosing(false);
      setDecisionNote("");
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

  function createLocalWorkerTile(pathValue: string, index: number): WorkerTile {
    return {
      key: `local-${pathValue}`,
      name: `OpenCode-${index + 1}`,
      subtitle: "Configured",
      capabilities: ["Code generation", "File editing", "Command execution"],
      lamp: "offline"
    };
  }

  const workerTiles: WorkerTile[] = (() => {
    const configured = workers.map((worker) => ({
      key: worker.worker_id,
      name: worker.name,
      subtitle: worker.adapter_type,
      capabilities: worker.capabilities,
      lamp: workerLamp(worker)
    }));

    const localConfigured = localWorkerPaths.map((pathValue, index) => createLocalWorkerTile(pathValue, index));

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

    const existingNames = new Set([...configured, ...localConfigured].map((item) => item.name.toLowerCase()));
    return [
      ...configured,
      ...localConfigured,
      ...placeholders.filter((item) => !existingNames.has(item.name.toLowerCase()))
    ];
  })();

  function submitLocalWorkerPath() {
    const trimmed = newWorkerPath.trim();
    if (!trimmed) {
      return;
    }
    setLocalWorkerPaths((current) => (
      current.includes(trimmed) ? current : [...current, trimmed]
    ));
    setNewWorkerPath("");
    setShowWorkerCreateModal(false);
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
      const [demandsRes, workersRes, settingsRes] = await Promise.all([
        fetch(`${API_BASE}/demands`),
        fetch(`${API_BASE}/workers`),
        fetch(`${API_BASE}/settings`)
      ]);
      setDemands(await demandsRes.json());
      setWorkers(await workersRes.json());
      const nextSettings = await settingsRes.json();
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
      const response = await fetch(`${API_BASE}/demands/${demandId}`);
      const nextDetail = await response.json();
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
      const response = await fetch(`${API_BASE}/demands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initial_input: newDemand })
      });

      if (createSessionId !== createSessionRef.current) {
        return;
      }

      if (!response.ok) {
        const error = await response.json();
        setDashboardView("create");
        setDetailLoading(false);
        window.alert(error.error ?? "Failed to create demand");
        return;
      }

      const created = await response.json();
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
    } finally {
      if (createSessionId === createSessionRef.current) {
        setCreateSubmitting(false);
      }
    }
  }

  async function deleteDemand(demandId: string, options?: { animateBoardExit?: boolean }) {
    if (options?.animateBoardExit) {
      setBoardDismissingId(demandId);
      await new Promise((resolve) => window.setTimeout(resolve, 220));
    }
    setDeleteSubmittingId(demandId);
    try {
      await fetch(`${API_BASE}/demands/${demandId}`, { method: "DELETE" });
      if (detail?.demand.demand_id === demandId || activeDemandId === demandId) {
        setDetail(null);
        setActiveDemandId(null);
      }
      await loadDashboard();
    } finally {
      setDeleteSubmittingId(null);
      setBoardDismissingId((current) => (current === demandId ? null : current));
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
      const response = await fetch(`${API_BASE}/demands/${detail.demand.demand_id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input_text: replyText })
      });

      if (!response.ok) {
        const error = await response.json();
        setClarificationReply(replyText);
        window.alert(error.error ?? "Failed to send clarification reply");
        return;
      }

      await loadDashboard();
      await loadDemandDetail(detail.demand.demand_id);
    } finally {
      setReplySubmitting(false);
      setAssistantTyping(false);
      setConversationPending([]);
    }
  }

  async function saveSettings() {
    setSettingsSaving(true);
    try {
      const response = await fetch(`${API_BASE}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settingsDraft)
      });
      const saved = await response.json();
      setSettings(saved);
      setSettingsDraft(saved);
      setSettingsDirty(false);
      setSettingsStatus("Settings saved");
    } finally {
      setSettingsSaving(false);
    }
  }

  async function respondToDecision(decisionId: string, action: string) {
    if (!detail) {
      return;
    }

    const note = decisionNote.trim();
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
      const response = await fetch(`${API_BASE}/decisions/${decisionId}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          note: note || null
        })
      });

      if (!response.ok) {
        const error = await response.json();
        if (triggerReplanTransition) {
          setPlanTransitionMode("idle");
        }
        window.alert(error.error ?? "Failed to respond to decision");
        return;
      }

      setDecisionNote("");
      await loadDashboard();
      await loadDemandDetail(detail.demand.demand_id);
      if (triggerReplanTransition) {
        setPlanTransitionMode("idle");
      }
    } finally {
      setDecisionSubmitting(null);
    }
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
        : deleteSubmittingId
          ? "Deleting demand"
          : settingsSaving
            ? "Saving settings"
            : decisionSubmitting
              ? "Submitting decision"
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

    const socket = new WebSocket(`${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`);
    socket.onmessage = (message) => {
      const data = JSON.parse(message.data) as { type: string; payload: unknown };
      if (data.type === "workers") {
        setWorkers(data.payload as Worker[]);
      }
      if (data.type === "demand_view" && activeDemandId && data.payload) {
        const payload = data.payload as DemandDetail;
        if (payload.demand.demand_id === activeDemandId && createSessionRef.current >= 0) {
          setDetail(payload);
        }
      }
      if (data.type === "event") {
        void loadDashboard({ silent: true });
      }
    };
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
            </button>
          ))}
        </nav>
      </header>

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
                              title="Delete demand"
                              disabled={deleteSubmittingId === demand.demand_id}
                              onClick={() => {
                                void deleteDemand(demand.demand_id, { animateBoardExit: true });
                              }}
                            >
                              {deleteSubmittingId === demand.demand_id ? "…" : "×"}
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
                        <button
                          type="button"
                          className="ghost-button danger-button"
                          disabled={deleteSubmittingId === detail.demand.demand_id}
                          onClick={() => void deleteDemand(detail.demand.demand_id)}
                        >
                          {deleteSubmittingId === detail.demand.demand_id ? "Deleting..." : "Delete Demand"}
                        </button>
                      </div>
                    </div>
                  </section>

                  <div className="detail-grid detail-grid-plan-only">
                    <section className="panel detail-section section-b plan-panel">
                      <div className="panel-heading">
                        <div>
                          <p className="eyebrow">Planner View</p>
                          <h2>Plan</h2>
                        </div>
                        <span className="status-chip">{detail.subgoals.length} subgoals</span>
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
                              {conversationHistory.map((message, index) => (
                                <div
                                  key={`${message.created_at}-${index}`}
                                  className={message.role === "assistant" ? "conversation-turn assistant" : "conversation-turn user"}
                                >
                                  <small>{message.role === "assistant" ? "Assistant" : "You"}</small>
                                  <p>{message.content}</p>
                                </div>
                              ))}
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
                                            <div key={subgoal.subgoal_id} className="plan-subgoal-card plan-subgoal-grid">
                                              <div className="subgoal-zone subgoal-zone-main">
                                                <strong>{subgoal.title}</strong>
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
                                      <div key={subgoal.subgoal_id} className="plan-subgoal-card plan-subgoal-grid">
                                        <div className="subgoal-zone subgoal-zone-main">
                                          <strong>{subgoal.title}</strong>
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
                          {conversationHistory.map((message, index) => (
                            <div
                              key={`${message.created_at}-${index}`}
                              className={message.role === "assistant" ? "conversation-turn assistant" : "conversation-turn user"}
                            >
                              <small>{message.role === "assistant" ? "Assistant" : "You"}</small>
                              <p>{message.content}</p>
                            </div>
                          ))}
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
                                  value={decisionNote}
                                  onChange={(event) => setDecisionNote(event.target.value)}
                                  placeholder="Reply to this failed subgoal and provide the next instruction or missing context"
                                />
                              </label>
                              <div className="decision-modal-actions">
                                <button
                                  type="button"
                                  className="ghost-button"
                                  disabled={decisionSubmitting === selectedDialogDecision.decision_id || !decisionNote.trim()}
                                  onClick={() => void respondToDecision(selectedDialogDecision.decision_id, "ProvideInfo")}
                                >
                                  {decisionSubmitting === selectedDialogDecision.decision_id ? "Sending..." : "Reply"}
                                </button>
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
                  <strong>{workerTiles.length}</strong>
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
                Connect a worker runtime to the fleet.
              </p>
              <label className="field">
                <span>Worker Runtime</span>
                <input
                  value={newWorkerPath}
                  onChange={(event) => setNewWorkerPath(event.target.value)}
                  placeholder="e.g. OpenCode runtime"
                />
              </label>
              <div className="modal-actions">
                <button className="ghost-button" onClick={() => setShowWorkerCreateModal(false)}>Cancel</button>
                <button className="primary" disabled={!newWorkerPath.trim()} onClick={submitLocalWorkerPath}>Create Worker</button>
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
