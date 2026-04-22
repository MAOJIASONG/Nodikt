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
export type AdapterType = "codex" | "opencode";
export type RuntimeType = "local_command" | "http" | "websocket";
export type ArtifactType = "git_commit" | "pull_request" | "file_bundle" | "structured_output_json";
export type ArtifactBackend = "git" | "filesystem";
export type DecisionSource = "scheduler" | "worker" | "verifier" | "ops";
export type HeartbeatSource = "synthetic_timer" | "event_stream" | "hook" | "status_poll";
export type InstallScope = "workspace_only" | "disabled";
export type EventReason = "initial_plan" | "replan_after_result" | "replan_after_decision" | "resume";
export type InputKind = "initial_demand" | "clarification_reply" | "decision_note" | "control_action";
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
  created_at: string;
  updated_at: string;
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
  enabled: boolean;
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
  source: "ui";
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
}

export interface DecisionRequestCreatedPayload {
  decision_request: DecisionRequest;
}

export interface DecisionResponseReceivedPayload {
  decision_response: DecisionResponse;
}

export interface OpsAlertPayload {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
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
  [EventType.DECISION_REQUEST_CREATED]: DecisionRequestCreatedPayload;
  [EventType.DECISION_RESPONSE_RECEIVED]: DecisionResponseReceivedPayload;
  [EventType.REPLAN_REQUESTED]: { reason: EventReason };
  [EventType.DEMAND_PAUSED]: DemandControlPayload;
  [EventType.DEMAND_RESUMED]: DemandControlPayload;
  [EventType.DEMAND_CANCELLED]: DemandControlPayload;
  [EventType.EXECUTION_STOP_REQUESTED]: { reason?: string };
  [EventType.OPS_ALERT]: OpsAlertPayload;
  [EventType.MISSION_COMPLETED]: MissionCompletedPayload;
};

export interface DemandView {
  demand: Demand;
  subgoals: SubgoalContract[];
  executions: Execution[];
  decisions: DecisionRequest[];
  memory: MemoryRecord[];
  events: SchedulerEvent[];
}
