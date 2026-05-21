export type AutonomyLevel = "L0" | "L1" | "L2" | "L3" | "L4";
export type AdapterType = "codex" | "claude_code" | "opencode";
export type RuntimeType = "local_command" | "http" | "websocket";
export type ArtifactType = "git_commit" | "pull_request" | "file_bundle" | "structured_output_json";
export type ArtifactBackend = "git" | "filesystem";
export type DecisionAction = "Approve" | "Reject" | "ProvideInfo" | "Pause" | "Stop" | "CancelDemand";

export type OperationalObjective = {
  objective: string;
  acceptance_criteria: string[];
  constraints: string[];
  non_goals?: string[];
  termination_conditions?: string[];
};

export type DemandRuntimeSession = {
  phase?: string;
  waiting_on?: string | null;
  frontier_subgoal_ids?: string[];
  latest_checkpoint?: string;
  progress_note?: string;
  last_progress_at?: string;
};

export type DemandLatestPlan = {
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

export type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
  created_at: string;
  optimistic?: boolean;
};

export type Demand = {
  demand_id: string;
  title: string;
  type: "project" | "reminder";
  state: string;
  current_phase: string;
  clarified_demand: string | null;
  initial_input: string;
  operational_objective: OperationalObjective | null;
  autonomy_level: AutonomyLevel;
  acceptance_criteria: string[];
  constraints: string[];
  progress_percent: number;
  active_decision_id: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  dashboard_summary?: {
    current_subgoal_title?: string | null;
    worker_count?: number;
  };
  metadata?: {
    runtime_session?: DemandRuntimeSession;
    clarification_question?: string | null;
    conversation_history?: ConversationMessage[];
    latest_plan?: DemandLatestPlan;
    [key: string]: unknown;
  };
};

export type WorkerAdapterConfig = {
  workspace_root?: string;
  command?: string;
  args?: string[];
  endpoint?: string;
  api_key?: string | null;
  env?: Record<string, string>;
  timeout_seconds?: number;
  metadata?: Record<string, unknown>;
};

export type Worker = {
  worker_id: string;
  name: string;
  adapter_type: AdapterType;
  runtime_type?: RuntimeType;
  status: string;
  capabilities: string[];
  available_skills?: string[];
  max_concurrency?: number;
  current_execution_ids?: string[];
  last_seen_at?: string | null;
  last_error?: string | null;
  is_enabled?: boolean;
  config?: WorkerAdapterConfig;
};

export type WorkerTile = {
  key: string;
  name: string;
  subtitle: string;
  capabilities: string[];
  lamp: "online" | "offline" | "fault";
  status?: string;
  meta?: string;
};

export type WorkerRegistrationPayload = {
  name: string;
  adapter_type: AdapterType;
  runtime_type: RuntimeType;
  max_concurrency: number;
  capabilities: string[];
  config: WorkerAdapterConfig;
};

export type Decision = {
  decision_id: string;
  prompt: string;
  status: string;
  options?: DecisionAction[];
  reason_code?: string;
  source?: string;
  subgoal_id?: string | null;
  execution_id?: string | null;
  metadata?: {
    conversation_history?: ConversationMessage[];
    [key: string]: unknown;
  };
};

export type ArtifactRef = {
  artifact_id: string;
  artifact_type: ArtifactType | string;
  backend?: ArtifactBackend;
  uri: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
};

export type Execution = {
  execution_id: string;
  demand_id?: string;
  subgoal_id: string;
  worker_id: string;
  state: string;
  attempt?: number;
  started_at: string | null;
  completed_at: string | null;
  last_heartbeat_at: string | null;
  latest_worker_status: string | null;
  result_status: string | null;
  claimed_outcome: string | null;
  compressed_history: string;
  artifacts: ArtifactRef[];
  adapter_meta?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type WorkerResultEventPayload = {
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

export type DemandEvent = {
  event_id: string;
  event_type: string;
  created_at: string;
  demand_id?: string | null;
  execution_id?: string | null;
  subgoal_id?: string | null;
  decision_id?: string | null;
  payload?: WorkerResultEventPayload | Record<string, unknown>;
};

export type Subgoal = {
  subgoal_id: string;
  demand_id?: string;
  title: string;
  state: string;
  objective: string;
  success_criteria?: string[];
  failure_criteria?: string[];
  constraints?: string[];
  dependencies?: string[];
  priority?: number;
  planning_round?: number;
  kind?: "build" | "recon";
};

export type MemoryRecord = {
  memory_id: string;
  category: "mission_state" | "episodic_trace" | "lessons_or_policy" | string;
  content: string;
  created_at?: string;
  updated_at?: string;
};

export type DemandDetail = {
  demand: Demand;
  subgoals: Subgoal[];
  executions: Execution[];
  decisions: Decision[];
  events: DemandEvent[];
  memory: MemoryRecord[];
};

export type ModelConfig = {
  provider: string;
  model: string;
  base_url: string;
  api_key: string;
  enabled: boolean;
};

export type Settings = {
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
   * 永久授权 worker 可访问的额外路径清单。worker 跑任务时，如果 demand 想写到 workspace_root
   * 之外的目录，且目录已在这个清单或当前 demand 的 metadata.workspace_grants 里，就免询问直接放行；
   * 否则弹 PATH_GRANT_REQUIRED 决策卡问用户。
   */
  workspace_grants?: Array<{ path: string; granted_at: string }> | null;
  runtime: {
    heartbeat_interval_seconds: number;
    execution_timeout_seconds: number;
    max_retry_count: number;
  };
  worker_policy: {
    skill_install_scope: string;
  };
  default_autonomy_level: AutonomyLevel;
  default_permissions: {
    can_modify_files: boolean;
    can_run_commands: boolean;
    can_install_dependencies: boolean;
    can_open_pr: boolean;
  };
};

export type SocketMessage =
  | { type: "event"; payload: DemandEvent }
  | { type: "demand_view"; payload: DemandDetail | null }
  | { type: "workers"; payload: Worker[] };
