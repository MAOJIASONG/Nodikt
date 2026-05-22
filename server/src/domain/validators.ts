/**
 * 文件名称：validators.ts
 * 文件作用：领域数据校验模块，使用 Zod 定义持久化数据和接口数据的运行时校验规则。
 *
 * 主要职责：
 * 1. 为各类领域实体提供 schema 校验。
 * 2. 定义集合文件结构，保护 JSON 数据读写边界。
 * 3. 将 TypeScript 类型约束补充为运行时数据约束。
 *
 * 依赖模块：
 * - zod：运行时 schema 校验库。
 * - domain/enums：领域枚举值。
 *
 * 注意事项：
 * - 修改 types.ts 中实体结构时，应同步调整对应 schema。
 * - 对外部输入和持久化数据读取应优先经过本模块校验。
 */
import { z } from "zod";

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

export const artifactRefSchema = z.object({
  artifact_id: z.string().min(1),
  artifact_type: z.enum(["git_commit", "pull_request", "file_bundle", "structured_output_json"]),
  backend: z.enum(["git", "filesystem"]),
  uri: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
  created_at: z.string().datetime()
});

export const operationalObjectiveSchema = z.object({
  objective: z.string().min(1),
  acceptance_criteria: z.array(z.string()),
  constraints: z.array(z.string()),
  non_goals: z.array(z.string()).optional(),
  termination_conditions: z.array(z.string()).optional()
});

export const subgoalContractSchema = z.object({
  subgoal_id: z.string().min(1),
  demand_id: z.string().min(1),
  title: z.string().min(1),
  objective: z.string().min(1),
  success_criteria: z.array(z.string()),
  failure_criteria: z.array(z.string()),
  constraints: z.array(z.string()),
  budget: z.object({
    max_steps: z.number().int().positive().optional(),
    max_minutes: z.number().int().positive().optional(),
    max_cost_usd: z.number().nonnegative().optional(),
    max_actions: z.number().int().positive().optional()
  }),
  deliverables: z.array(z.enum(["git_commit", "pull_request", "file_bundle", "structured_output_json"])),
  dependencies: z.array(z.string()),
  priority: z.number().int().nonnegative(),
  state: z.nativeEnum(SubgoalState),
  planning_round: z.number().int().positive(),
  kind: z.enum(["build", "recon"]).optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});

export const demandSchema = z.object({
  demand_id: z.string().min(1),
  title: z.string().min(1),
  type: z.enum(["project", "reminder"]),
  initial_input: z.string().min(1),
  clarified_demand: z.string().nullable(),
  operational_objective: operationalObjectiveSchema.nullable(),
  state: z.nativeEnum(DemandState),
  autonomy_level: z.enum(["L0", "L1", "L2", "L3", "L4"]),
  acceptance_criteria: z.array(z.string()),
  constraints: z.array(z.string()),
  progress_percent: z.number().min(0).max(100),
  current_phase: z.nativeEnum(DemandPhase),
  active_decision_id: z.string().nullable(),
  tags: z.array(z.string()),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  metadata: z.record(z.unknown()).optional()
});

export const sessionSchema = z.object({
  session_id: z.string().min(1),
  demand_id: z.string().min(1),
  phase: z.nativeEnum(DemandPhase),
  current_summary: z.string(),
  frontier_subgoal_ids: z.array(z.string()),
  waiting_on: z.string().nullable(),
  latest_checkpoint: z.string().nullable(),
  last_progress_at: z.string().datetime(),
  status: z.nativeEnum(DemandState),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});

export const executionSchema = z.object({
  execution_id: z.string().min(1),
  demand_id: z.string().min(1),
  subgoal_id: z.string().min(1),
  worker_id: z.string().min(1),
  state: z.nativeEnum(ExecutionState),
  attempt: z.number().int().positive(),
  started_at: z.string().datetime().nullable(),
  completed_at: z.string().datetime().nullable(),
  last_heartbeat_at: z.string().datetime().nullable(),
  latest_worker_status: z.nativeEnum(WorkerExecutionStatus).nullable(),
  result_status: z.nativeEnum(WorkerResultStatus).nullable(),
  claimed_outcome: z.string().nullable(),
  compressed_history: z.string(),
  artifacts: z.array(artifactRefSchema),
  adapter_meta: z.record(z.unknown()),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});

export const workerRegistrationSchema = z.object({
  worker_id: z.string().min(1),
  name: z.string().min(1),
  adapter_type: z.enum(["codex", "opencode", "claude_code"]),
  runtime_type: z.enum(["local_command", "http", "websocket"]),
  status: z.nativeEnum(WorkerRegistryStatus),
  max_concurrency: z.number().int().positive(),
  capabilities: z.array(z.string()),
  available_skills: z.array(z.string()),
  install_policy: z.enum(["none", "allowed_with_review"]),
  config: z.object({
    workspace_root: z.string().min(1),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    endpoint: z.string().optional(),
    api_key: z.string().nullable().optional(),
    env: z.record(z.string()).optional(),
    timeout_seconds: z.number().int().positive().optional(),
    metadata: z.record(z.unknown()).optional()
  }),
  current_execution_ids: z.array(z.string()),
  last_seen_at: z.string().datetime().nullable(),
  last_error: z.string().nullable(),
  is_enabled: z.boolean(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});

export const decisionRequestSchema = z.object({
  schema_version: z.literal("v1"),
  decision_id: z.string().min(1),
  demand_id: z.string().min(1),
  subgoal_id: z.string().nullable().optional(),
  execution_id: z.string().nullable().optional(),
  source: z.enum(["scheduler", "worker", "verifier", "ops"]),
  reason_code: z.nativeEnum(DecisionReasonCode),
  prompt: z.string().min(1),
  options: z.array(z.nativeEnum(DecisionAction)),
  status: z.nativeEnum(DecisionStatus),
  created_at: z.string().datetime(),
  resolved_at: z.string().datetime().nullable().optional(),
  metadata: z.record(z.unknown()).optional()
});

export const decisionResponseSchema = z.object({
  schema_version: z.literal("v1"),
  decision_id: z.string().min(1),
  action: z.nativeEnum(DecisionAction),
  note: z.string().nullable().optional(),
  payload: z.record(z.unknown()).optional(),
  responded_at: z.string().datetime()
});

export const memoryRecordSchema = z.object({
  memory_id: z.string().min(1),
  demand_id: z.string().min(1),
  category: z.enum(["mission_state", "episodic_trace", "lessons_or_policy"]),
  content: z.string(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});

export const settingsSchema = z.object({
  version: z.literal("v1"),
  updated_at: z.string().datetime(),
  models: z.object({
    primary: z.object({
      provider: z.string(),
      model: z.string(),
      base_url: z.string(),
      api_key: z.string()
    }),
    planner: z.object({
      provider: z.string(),
      model: z.string(),
      base_url: z.string(),
      api_key: z.string()
    }),
    verifier: z.object({
      provider: z.string(),
      model: z.string(),
      base_url: z.string(),
      api_key: z.string()
    }),
    ops_backup: z.object({
      provider: z.string(),
      model: z.string(),
      base_url: z.string(),
      api_key: z.string()
    })
  }),
  workspace_root: z.string().min(1),
  workspace_grants: z.array(z.object({
    path: z.string().min(1),
    granted_at: z.string(),
    granted_by: z.string().optional(),
    note: z.string().optional()
  })).optional(),
  runtime: z.object({
    heartbeat_interval_seconds: z.number().int().positive(),
    execution_timeout_seconds: z.number().int().positive(),
    max_retry_count: z.number().int().nonnegative()
  }),
  worker_policy: z.object({
    skill_install_scope: z.enum(["workspace_only", "disabled"])
  }),
  default_autonomy_level: z.enum(["L0", "L1", "L2", "L3", "L4"]),
  default_permissions: z.object({
    can_modify_files: z.boolean(),
    can_run_commands: z.boolean(),
    can_install_dependencies: z.boolean(),
    can_open_pr: z.boolean()
  })
});

export const handlerFailedSchema = z.object({
  source_event_type: z.string(),
  message: z.string(),
  error_name: z.string(),
  failed_at: z.string()
});

export const schedulerEventSchema = z.object({
  event_id: z.string().min(1),
  event_type: z.nativeEnum(EventType),
  demand_id: z.string().nullable().optional(),
  subgoal_id: z.string().nullable().optional(),
  execution_id: z.string().nullable().optional(),
  decision_id: z.string().nullable().optional(),
  worker_id: z.string().nullable().optional(),
  payload: z.record(z.unknown()),
  created_at: z.string().datetime()
});

export const demandsCollectionSchema = z.object({
  version: z.literal("v1"),
  updated_at: z.string().datetime(),
  items: z.array(demandSchema)
});

export const subgoalsCollectionSchema = z.object({
  version: z.literal("v1"),
  updated_at: z.string().datetime(),
  items: z.array(subgoalContractSchema)
});

export const sessionsCollectionSchema = z.object({
  version: z.literal("v1"),
  updated_at: z.string().datetime(),
  items: z.array(sessionSchema)
});

export const executionsCollectionSchema = z.object({
  version: z.literal("v1"),
  updated_at: z.string().datetime(),
  items: z.array(executionSchema)
});

export const workersCollectionSchema = z.object({
  version: z.literal("v1"),
  updated_at: z.string().datetime(),
  items: z.array(workerRegistrationSchema)
});

export const decisionsCollectionSchema = z.object({
  version: z.literal("v1"),
  updated_at: z.string().datetime(),
  items: z.array(decisionRequestSchema)
});

export const eventsCollectionSchema = z.object({
  version: z.literal("v1"),
  updated_at: z.string().datetime(),
  items: z.array(schedulerEventSchema)
});

export const memoryCollectionSchema = z.object({
  version: z.literal("v1"),
  updated_at: z.string().datetime(),
  items: z.array(memoryRecordSchema)
});
