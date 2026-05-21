/**
 * 文件名称：types.ts
 * 文件作用：领域类型定义模块，描述 Nodikt 后端核心实体、事件载荷和跨模块数据契约。
 *
 * 主要职责：
 * 1. 定义需求、子目标、执行、工作器、决策、记忆和设置等实体结构。
 * 2. 定义调度事件载荷映射和处理结果类型。
 * 3. 为仓储、事件处理器、接口层和工作器适配器提供统一 TypeScript 契约。
 *
 * 依赖模块：
 * - domain/enums：核心状态和动作枚举。
 *
 * 注意事项：
 * - 类型变更通常需要同步更新 validators、数据仓储和前端消费逻辑。
 * - 本文件只定义类型，不应引入业务执行逻辑。
 */
import {
  DecisionAction,
  DecisionReasonCode,
  DecisionStatus,
  DemandPhase,
  DemandState,
  EventType,
  ExecutionState,
  SubgoalState,
  VerificationStatus,
  WorkerExecutionStatus,
  WorkerRegistryStatus,
  WorkerResultStatus
} from "./enums.js";

export type AutonomyLevel = "L0" | "L1" | "L2" | "L3" | "L4";
export type AdapterType = "codex" | "opencode" | "claude_code";
export type RuntimeType = "local_command" | "http" | "websocket";
export type ArtifactType = "git_commit" | "pull_request" | "file_bundle" | "structured_output_json";
export type ArtifactBackend = "git" | "filesystem";
export type DecisionSource = "scheduler" | "worker" | "verifier" | "ops";
export type HeartbeatSource = "synthetic_timer" | "event_stream" | "hook" | "status_poll";
export type InstallScope = "workspace_only" | "disabled";
export type EventReason = "initial_plan" | "replan_after_result" | "replan_after_decision" | "resume" | "user_triggered" | "recon_completed";
export type InputKind = "initial_demand" | "clarification_reply" | "decision_note" | "control_action" | "recon_findings";
export type LlmRole = "primary" | "planner" | "verifier" | "ops_backup";

export interface ArtifactRef {
  artifact_id: string;
  artifact_type: ArtifactType;
  backend: ArtifactBackend;
  uri: string;
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface Budget {
  max_steps?: number;
  max_minutes?: number;
  max_cost_usd?: number;
  max_actions?: number;
}

export interface WorkerPermissions {
  can_modify_files: boolean;
  can_run_commands: boolean;
  can_install_dependencies: boolean;
  can_open_pr: boolean;
}

export interface OperationalObjective {
  objective: string;
  acceptance_criteria: string[];
  constraints: string[];
  non_goals?: string[];
  termination_conditions?: string[];
}

export type SubgoalKind = "build" | "recon";

export interface SubgoalContract {
  subgoal_id: string;
  demand_id: string;
  title: string;
  objective: string;
  success_criteria: string[];
  failure_criteria: string[];
  constraints: string[];
  budget: Budget;
  deliverables: ArtifactType[];
  dependencies: string[];
  priority: number;
  state: SubgoalState;
  planning_round: number;
  /**
   * 子目标种类：
   * - "build"（默认）：执行型，目标是产出 artifact / 状态变更。
   * - "recon"：侦察型，只读不写，目标是收集信息让下一轮 planner 决策。
   * 兼容历史数据：缺省视为 "build"。
   */
  kind?: SubgoalKind;
  created_at: string;
  updated_at: string;
}

/**
 * 类型作用：路径授权条目，描述 worker 可以写入的某条额外路径以及来源。
 *
 * 字段说明：
 * - path：绝对路径或目录路径。worker 写入此路径或其子路径都视为已授权。
 * - granted_at：授权时间戳。
 * - granted_by：来源描述（"user_persistent" / "user_demand_scope" / "scheduler" 等）。
 */
export interface WorkspaceGrant {
  path: string;
  granted_at: string;
  granted_by?: string;
  note?: string;
}

export interface Demand {
  demand_id: string;
  title: string;
  type: "project" | "reminder";
  initial_input: string;
  clarified_demand: string | null;
  operational_objective: OperationalObjective | null;
  state: DemandState;
  autonomy_level: AutonomyLevel;
  acceptance_criteria: string[];
  constraints: string[];
  progress_percent: number;
  current_phase: DemandPhase;
  active_decision_id: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  metadata?: Record<string, unknown>;
}

export interface Session {
  session_id: string;
  demand_id: string;
  phase: DemandPhase;
  current_summary: string;
  frontier_subgoal_ids: string[];
  waiting_on: string | null;
  latest_checkpoint: string | null;
  last_progress_at: string;
  status: DemandState;
  created_at: string;
  updated_at: string;
}

export interface Execution {
  execution_id: string;
  demand_id: string;
  subgoal_id: string;
  worker_id: string;
  state: ExecutionState;
  attempt: number;
  started_at: string | null;
  completed_at: string | null;
  last_heartbeat_at: string | null;
  latest_worker_status: WorkerExecutionStatus | null;
  result_status: WorkerResultStatus | null;
  claimed_outcome: string | null;
  compressed_history: string;
  artifacts: ArtifactRef[];
  adapter_meta: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface WorkerAdapterConfig {
  workspace_root: string;
  command?: string;
  args?: string[];
  endpoint?: string;
  api_key?: string | null;
  env?: Record<string, string>;
  timeout_seconds?: number;
  metadata?: Record<string, unknown>;
}

export interface WorkerRegistration {
  worker_id: string;
  name: string;
  adapter_type: AdapterType;
  runtime_type: RuntimeType;
  status: WorkerRegistryStatus;
  max_concurrency: number;
  capabilities: string[];
  available_skills: string[];
  install_policy: "none" | "allowed_with_review";
  config: WorkerAdapterConfig;
  current_execution_ids: string[];
  last_seen_at: string | null;
  last_error: string | null;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface DecisionRequest {
  schema_version: "v1";
  decision_id: string;
  demand_id: string;
  subgoal_id?: string | null;
  execution_id?: string | null;
  source: DecisionSource;
  reason_code: DecisionReasonCode;
  prompt: string;
  options: DecisionAction[];
  status: DecisionStatus;
  created_at: string;
  resolved_at?: string | null;
  metadata?: Record<string, unknown>;
}

export interface DecisionResponse {
  schema_version: "v1";
  decision_id: string;
  action: DecisionAction;
  note?: string | null;
  payload?: Record<string, unknown>;
  responded_at: string;
}

export interface MemoryRecord {
  memory_id: string;
  demand_id: string;
  category: "mission_state" | "episodic_trace" | "lessons_or_policy";
  content: string;
  created_at: string;
  updated_at: string;
}

export interface Settings {
  version: "v1";
  updated_at: string;
  models: {
    primary: ModelConfig;
    planner: ModelConfig;
    verifier: ModelConfig;
    ops_backup: ModelConfig;
  };
  workspace_root: string;
  /**
   * 用户级永久授权的额外可写路径列表。worker 默认可以写到 workspace_root，
   * 这里追加的路径在所有 demand 中都生效。
   */
  workspace_grants?: WorkspaceGrant[];
  runtime: {
    heartbeat_interval_seconds: number;
    execution_timeout_seconds: number;
    max_retry_count: number;
  };
  worker_policy: {
    skill_install_scope: InstallScope;
  };
  default_autonomy_level: AutonomyLevel;
  default_permissions: WorkerPermissions;
}

export interface ModelConfig {
  provider: string;
  model: string;
  base_url: string;
  api_key: string;
}

export interface SkillRef {
  name: string;
  path?: string;
  version?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkerContextSlice {
  mission_state_summary: string;
  relevant_history: string;
  relevant_artifacts: ArtifactRef[];
  shared_hints: string[];
  environment_notes: string[];
  skills: SkillRef[];
}

export interface ReplyProtocol {
  result_schema_version: "v1";
  heartbeat_interval_seconds: number;
  execution_timeout_seconds: number;
  cadence_hint?: {
    partial_after_steps?: number;
    partial_after_minutes?: number;
  };
}

export interface WorkerDispatchPacket {
  schema_version: "v1";
  execution_id: string;
  demand_id: string;
  subgoal_id: string;
  worker_id: string;
  clarified_demand: string;
  operational_objective: OperationalObjective;
  subgoal_contract: SubgoalContract;
  context_slice: WorkerContextSlice;
  permissions: WorkerPermissions;
  reply_protocol: ReplyProtocol;
  created_at: string;
}

export interface WorkerHeartbeat {
  schema_version: "v1";
  worker_id: string;
  execution_id?: string | null;
  status: WorkerExecutionStatus;
  progress_note?: string | null;
  source: HeartbeatSource;
  emitted_at: string;
  adapter_meta?: Record<string, unknown>;
}

export interface WorkerResult {
  schema_version: "v1";
  execution_id: string;
  worker_id: string;
  worker_status: WorkerResultStatus;
  claimed_outcome?: string | null;
  compressed_history: string;
  produced_artifacts: ArtifactRef[];
  blocker_reason?: {
    code: string;
    message: string;
  } | null;
  suggested_next_step?: string | null;
  budget_used?: {
    steps?: number;
    duration_ms?: number;
    estimated_cost_usd?: number;
  };
  adapter_meta?: Record<string, unknown>;
  returned_at: string;
}

export interface VerificationResult {
  schema_version: "v1";
  execution_id: string;
  subgoal_id: string;
  verified_status: VerificationStatus;
  accepted_artifacts: ArtifactRef[];
  gap: string[];
  notes: string;
  verified_at: string;
}

export interface SchedulerEvent<TPayload = unknown> {
  event_id: string;
  event_type: EventType;
  demand_id?: string | null;
  subgoal_id?: string | null;
  execution_id?: string | null;
  decision_id?: string | null;
  worker_id?: string | null;
  payload: TPayload;
  created_at: string;
}

export interface CollectionFile<TItem> {
  version: "v1";
  updated_at: string;
  items: TItem[];
}

export interface UserInputReceivedPayload {
  input_text: string;
  input_kind: InputKind;
  /**
   * 输入来源：
   * - "ui"：用户在 web 界面提交
   * - "scheduler"：系统内部回灌（典型场景：recon worker 完成后把发现回写给 clarifier 重新决策）
   */
  source: "ui" | "scheduler";
  session_tag?: string | null;
}

export interface DemandClarificationCompletedPayload {
  clarified_demand: string;
  operational_objective: OperationalObjective;
  acceptance_criteria: string[];
  constraints: string[];
  clarification_summary: string;
}

export interface PlanGeneratedPayload {
  planning_round: number;
  dependency_graph_snapshot: Record<string, unknown>;
  frontier_subgoal_ids: string[];
  overall_plan_outline: Array<{
    plan_item_id: string;
    title: string;
    objective: string;
    execution_mode: "parallel" | "sequential";
    rationale: string;
    frontier_subgoal_ids: string[];
  }>;
  high_level_summary: {
    mission_state_summary: string;
    episodic_trace_summary: string;
    lessons_or_policy_summary: string;
  };
  reason: EventReason;
}

export interface SubgoalCreatedPayload {
  subgoal_contract: SubgoalContract;
  planning_round: number;
  source: "planner";
}

export interface SubgoalMarkedReadyPayload {
  dependency_check: {
    satisfied_dependencies: string[];
    remaining_dependencies: string[];
  };
}

export interface ExecutionCreatedPayload {
  execution: Execution;
  dispatch_packet: WorkerDispatchPacket;
}

export interface ExecutionDispatchedPayload {
  adapter_type: AdapterType;
  runtime_type: RuntimeType;
  dispatch_started_at: string;
}

export interface WorkerHeartbeatPayload {
  heartbeat: WorkerHeartbeat;
}

export interface WorkerResultPayload {
  worker_result: WorkerResult;
}

export interface VerificationCompletedPayload {
  verification_result: VerificationResult;
}

export interface ReconciliationCompletedPayload {
  verification_status: VerificationStatus;
  decision_id?: string | null;
  mission_completed: boolean;
  replan_requested: boolean;
  retry_requested?: boolean;
  retry_attempt?: number;
}

export interface SubgoalRetryRequestedPayload {
  reason: "retry_after_failed_verification";
  previous_execution_id: string;
  retry_attempt: number;
  max_retry_count: number;
}

export interface DecisionRequestCreatedPayload {
  decision_request: DecisionRequest;
}

export interface DecisionResponseReceivedPayload {
  decision_response: DecisionResponse;
}

export interface ExecutionTimeoutDetectedPayload {
  timeout_seconds: number;
  heartbeat_interval_seconds: number;
  last_heartbeat_at?: string | null;
  reason: "heartbeat_missing" | "execution_budget_exceeded" | "wall_clock_timeout";
}

export interface WorkerHealthCheckedPayload {
  worker_id: string;
  ok: boolean;
  message: string;
  checked_at: string;
}

export interface OpsRecoveryAttemptedPayload {
  strategy: "retry_same_worker" | "retry_alternate_worker" | "escalate";
  reason: string;
  previous_execution_id?: string | null;
  next_execution_id?: string | null;
  attempt: number;
  max_retry_count: number;
}

export interface OpsRecoveryFailedPayload {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface OpsAlertPayload {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  details?: Record<string, unknown>;
}

export interface MissionCompletedPayload {
  summary: string;
}

export interface DemandControlPayload {
  action: "pause" | "resume" | "cancel";
  note?: string;
}

export interface HandlerResult {
  events?: SchedulerEvent<unknown>[];
}

export type EventPayloadMap = {
  [EventType.USER_INPUT_RECEIVED]: UserInputReceivedPayload;
  [EventType.DEMAND_CREATED]: Record<string, never>;
  [EventType.DEMAND_CLARIFICATION_COMPLETED]: DemandClarificationCompletedPayload;
  [EventType.PLAN_GENERATED]: PlanGeneratedPayload;
  [EventType.SUBGOAL_CREATED]: SubgoalCreatedPayload;
  [EventType.SUBGOAL_MARKED_READY]: SubgoalMarkedReadyPayload;
  [EventType.EXECUTION_CREATED]: ExecutionCreatedPayload;
  [EventType.EXECUTION_DISPATCHED]: ExecutionDispatchedPayload;
  [EventType.WORKER_HEARTBEAT_RECEIVED]: WorkerHeartbeatPayload;
  [EventType.WORKER_RESULT_RECEIVED]: WorkerResultPayload;
  [EventType.VERIFICATION_COMPLETED]: VerificationCompletedPayload;
  [EventType.RECONCILIATION_COMPLETED]: ReconciliationCompletedPayload;
  [EventType.SUBGOAL_RETRY_REQUESTED]: SubgoalRetryRequestedPayload;
  [EventType.DECISION_REQUEST_CREATED]: DecisionRequestCreatedPayload;
  [EventType.DECISION_RESPONSE_RECEIVED]: DecisionResponseReceivedPayload;
  [EventType.REPLAN_REQUESTED]: { reason: EventReason; note?: string | null; source?: string };
  [EventType.DEMAND_PAUSED]: DemandControlPayload;
  [EventType.DEMAND_RESUMED]: DemandControlPayload;
  [EventType.DEMAND_CANCELLED]: DemandControlPayload;
  [EventType.EXECUTION_STOP_REQUESTED]: { reason?: string; note?: string | null };
  [EventType.EXECUTION_TIMEOUT_DETECTED]: ExecutionTimeoutDetectedPayload;
  [EventType.WORKER_HEALTH_CHECKED]: WorkerHealthCheckedPayload;
  [EventType.OPS_RECOVERY_ATTEMPTED]: OpsRecoveryAttemptedPayload;
  [EventType.OPS_RECOVERY_FAILED]: OpsRecoveryFailedPayload;
  [EventType.OPS_ALERT]: OpsAlertPayload;
  [EventType.MISSION_COMPLETED]: MissionCompletedPayload;
};

export interface DemandView {
  demand: Demand;
  session: Session | null;
  subgoals: SubgoalContract[];
  executions: Execution[];
  decisions: DecisionRequest[];
  memory: MemoryRecord[];
  events: SchedulerEvent[];
}
