Nodikt Event Payload Schema v1

1. 文档目标

本文档定义 Nodikt Scheduler v1 中核心事件的 payload 结构。

目标：
	•	为 events.json 中的 payload 提供确定字段
	•	为 Scheduler handlers 提供固定输入
	•	为 WebSocket 推送与前端展示提供一致结构
	•	避免 Claude Code / Codex 在事件字段上自由发挥

适用前提：
	•	Scheduler 是代码主导的事件驱动状态机
	•	事件名已在《事件表 + 状态迁移表》中冻结
	•	本文档只定义 payload 内容，不重复定义事件总表

⸻

2. 统一约定

2.1 Event Envelope

所有事件都包在统一外层：

type SchedulerEvent<TPayload = Record<string, unknown>> = {
  event_id: string
  event_type: EventType
  demand_id?: string | null
  subgoal_id?: string | null
  execution_id?: string | null
  decision_id?: string | null
  worker_id?: string | null
  payload: TPayload
  created_at: string
}

2.2 设计原则
	•	envelope 放“索引字段”，如 demand_id / subgoal_id / execution_id
	•	payload 放“事件细节”
	•	不在 payload 里重复放不必要的 envelope 字段，除非该事件消费者单独需要

2.3 空 payload 规则

若事件无需额外细节，payload 也必须是 {}，不能为 null。

⸻

3. 核心类型引用

3.1 OperationalObjective

type OperationalObjective = {
  objective: string
  acceptance_criteria: string[]
  constraints: string[]
  non_goals?: string[]
  termination_conditions?: string[]
}

3.2 ArtifactRef

type ArtifactRef = {
  artifact_id: string
  artifact_type: "git_commit" | "pull_request" | "file_bundle" | "structured_output_json"
  backend: "git" | "filesystem"
  uri: string
  metadata?: Record<string, unknown>
  created_at: string
}

3.3 SubgoalContract

type SubgoalContract = {
  subgoal_id: string
  title: string
  objective: string
  success_criteria: string[]
  failure_criteria: string[]
  constraints: string[]
  budget: {
    max_steps?: number
    max_minutes?: number
    max_cost_usd?: number
    max_actions?: number
  }
  deliverables: Array<
    "git_commit" | "pull_request" | "file_bundle" | "structured_output_json"
  >
  dependencies: string[]
  priority: number
}

3.4 WorkerResult

type WorkerResult = {
  schema_version: "v1"
  execution_id: string
  worker_id: string
  worker_status: "DONE" | "BLOCKED" | "FAILED" | "NEED_HELP" | "PARTIAL"
  claimed_outcome?: string | null
  compressed_history: string
  produced_artifacts: ArtifactRef[]
  blocker_reason?: {
    code: string
    message: string
  } | null
  suggested_next_step?: string | null
  budget_used?: {
    steps?: number
    duration_ms?: number
    estimated_cost_usd?: number
  }
  adapter_meta?: Record<string, unknown>
  returned_at: string
}

3.5 VerificationResult

type VerificationResult = {
  schema_version: "v1"
  execution_id: string
  subgoal_id: string
  verified_status: "VERIFIED_DONE" | "PARTIAL" | "FAILED" | "UNVERIFIABLE"
  accepted_artifacts: ArtifactRef[]
  notes: string
  verified_at: string
}

3.6 DecisionRequest

type DecisionRequest = {
  schema_version: "v1"
  decision_id: string
  demand_id: string
  subgoal_id?: string | null
  execution_id?: string | null
  source: "scheduler" | "worker" | "verifier" | "ops"
  reason_code:
    | "MISSING_INFO"
    | "MISSING_PERMISSION"
    | "INSTALL_REQUIRES_REVIEW"
    | "PLAN_CONFLICT"
    | "UNVERIFIABLE_RESULT"
    | "HIGH_RISK_ACTION"
    | "BLOCKED"
    | "OPS_ALERT"
  prompt: string
  options: Array<"Approve" | "Reject" | "ProvideInfo" | "Pause" | "Stop" | "CancelDemand">
  status: "OPEN" | "RESOLVED" | "EXPIRED" | "CANCELLED"
  created_at: string
}

3.7 DecisionResponse

type DecisionResponse = {
  schema_version: "v1"
  decision_id: string
  action: "Approve" | "Reject" | "ProvideInfo" | "Pause" | "Stop" | "CancelDemand"
  note?: string | null
  payload?: Record<string, unknown>
  responded_at: string
}


⸻

4. 事件 Payload 定义

4.1 USER_INPUT_RECEIVED.payload

用途

记录用户输入被 Interface / Session Manager 接收。

type UserInputReceivedPayload = {
  input_text: string
  input_kind: "initial_demand" | "clarification_reply" | "decision_note" | "control_action"
  source: "ui"
  session_tag?: string | null
}

说明
	•	initial_demand: 新建 demand 时的输入
	•	clarification_reply: 澄清阶段的追加输入
	•	decision_note: 对 decision 的补充文字
	•	control_action: 通过 UI 发起的结构化控制动作（例如 pause/stop）

⸻

4.2 DEMAND_CLARIFICATION_COMPLETED.payload

用途

澄清阶段完成，Demand 从 PENDING_ALIGNMENT -> READY。

type DemandClarificationCompletedPayload = {
  clarified_demand: string
  operational_objective: OperationalObjective
  acceptance_criteria: string[]
  constraints: string[]
  clarification_summary: string
}

说明
	•	clarification_summary 给前端/日志展示用
	•	operational_objective 是 planner 后续 planning 的正式输入

⸻

4.3 PLAN_GENERATED.payload

用途

Planner 已完成一轮 planning，产出 dependency graph 更新和当前 frontier。

type PlanGeneratedPayload = {
  planning_round: number
  dependency_graph_snapshot: Record<string, unknown>
  frontier_subgoal_ids: string[]
  high_level_summary: {
    mission_state_summary: string
    episodic_trace_summary: string
    lessons_or_policy_summary: string
  }
  reason: "initial_plan" | "replan_after_result" | "replan_after_decision" | "resume"
}

说明
	•	frontier_subgoal_ids 只包含当前轮真正要推进的 subgoals
	•	dependency_graph_snapshot 可以先是宽对象，v1 不必再额外 schema 化

⸻

4.4 SUBGOAL_CREATED.payload

用途

某个 SubgoalContract 已生成并写入快照。

type SubgoalCreatedPayload = {
  subgoal_contract: SubgoalContract
  planning_round: number
  source: "planner"
}


⸻

4.5 SUBGOAL_MARKED_READY.payload

用途

某个 subgoal 已满足依赖，可进入派发。

type SubgoalMarkedReadyPayload = {
  dependency_check: {
    satisfied_dependencies: string[]
    remaining_dependencies: string[]
  }
  readiness_reason: "all_dependencies_satisfied" | "manual_unblock" | "replanned"
}


⸻

4.6 EXECUTION_CREATED.payload

用途

Dispatcher 已选择 worker，并为某个 subgoal 创建 execution 记录。

type ExecutionCreatedPayload = {
  worker_id: string
  dispatch_packet_version: "v1"
  worker_context_summary: {
    mission_state_summary: string
    relevant_history: string
    artifact_count: number
    skill_names: string[]
  }
}

说明
	•	这里只放 dispatch 摘要，不把完整 packet 重复塞进 event payload
	•	完整 packet 放在 executions.json 对应 execution 记录里

⸻

4.7 EXECUTION_DISPATCHED.payload

用途

execution 已真正下发给 worker。

type ExecutionDispatchedPayload = {
  worker_id: string
  adapter_type: "codex" | "opencode"
  runtime_type: "local_command" | "http" | "websocket"
  dispatch_mode: "push"
  heartbeat_interval_seconds: number
  execution_timeout_seconds: number
}


⸻

4.8 WORKER_HEARTBEAT_RECEIVED.payload

用途

收到 adapter 统一后的 heartbeat。

type WorkerHeartbeatReceivedPayload = {
  status: "idle" | "running" | "blocked" | "offline" | "error"
  progress_note?: string | null
  source: "synthetic_timer" | "event_stream" | "hook" | "status_poll"
  timestamp: string
}


⸻

4.9 WORKER_RESULT_RECEIVED.payload

用途

收到 worker 执行结果。

type WorkerResultReceivedPayload = {
  worker_result: WorkerResult
}

说明
	•	这里直接包完整 WorkerResult
	•	handler 不应再去猜字段

⸻

4.10 EXECUTION_TIMEOUT_DETECTED.payload

用途

Ops / timeout monitor 检测到 execution 超时。

type ExecutionTimeoutDetectedPayload = {
  timeout_seconds: number
  heartbeat_interval_seconds: number
  last_heartbeat_at?: string | null
  reason: "heartbeat_missing" | "execution_budget_exceeded" | "wall_clock_timeout"
}


⸻

4.11 VERIFICATION_COMPLETED.payload

用途

Verifier 已对 execution 结果完成验证。

type VerificationCompletedPayload = {
  verification_result: VerificationResult
}


⸻

4.12 RECONCILIATION_COMPLETED.payload

用途

Reconciliation 已落完状态与记忆，并决定下一步。

type ReconciliationCompletedPayload = {
  subgoal_final_state: "DONE" | "BLOCKED" | "FAILED"
  execution_final_state: "DONE" | "FAILED" | "INTERRUPTED" | "TIMEOUT" | "CANCELLED"
  accepted_artifact_ids: string[]
  memory_updates: {
    mission_state_updated: boolean
    episodic_trace_updated: boolean
    lessons_or_policy_updated: boolean
  }
  next_action: "create_decision" | "request_replan" | "complete_mission" | "no_op"
}

说明
	•	这个事件很适合给前端做 timeline 展示
	•	也很适合给 debug 用

⸻

4.13 DECISION_REQUEST_CREATED.payload

用途

执行阶段需要人类介入，创建决策请求。

type DecisionRequestCreatedPayload = {
  decision_request: DecisionRequest
}


⸻

4.14 DECISION_RESPONSE_RECEIVED.payload

用途

用户在 Human Decision Panel 中作出回应。

type DecisionResponseReceivedPayload = {
  decision_response: DecisionResponse
}


⸻

4.15 USER_PAUSE_REQUESTED.payload

用途

用户请求暂停 Demand。

type UserPauseRequestedPayload = {
  note?: string | null
  source: "ui"
}


⸻

4.16 USER_RESUME_REQUESTED.payload

用途

用户请求恢复 Demand。

type UserResumeRequestedPayload = {
  note?: string | null
  source: "ui"
  resume_policy: "replan_first"
}

说明

v1 固定：
	•	Resume -> PAUSED -> READY -> REPLAN_REQUESTED

⸻

4.17 USER_STOP_EXECUTION_REQUESTED.payload

用途

用户中断某个 execution。

type UserStopExecutionRequestedPayload = {
  note?: string | null
  source: "ui"
  stop_reason: "manual_interrupt"
}


⸻

4.18 USER_CANCEL_DEMAND_REQUESTED.payload

用途

用户取消整个 Demand。

type UserCancelDemandRequestedPayload = {
  note?: string | null
  source: "ui"
}


⸻

4.19 USER_STOP_WORKER_REQUESTED.payload

用途

用户停掉某个 worker。

type UserStopWorkerRequestedPayload = {
  note?: string | null
  source: "ui"
  affected_execution_ids: string[]
}


⸻

4.20 OPS_ALERT_RECEIVED.payload

用途

Ops 向 scheduler 报告告警。

type OpsAlertReceivedPayload = {
  level: "info" | "warning" | "error"
  code: string
  message: string
  details?: Record<string, unknown>
}


⸻

4.21 REPLAN_REQUESTED.payload

用途

请求 planner 基于最新状态重新进行一轮 planning。

type ReplanRequestedPayload = {
  reason:
    | "after_reconciliation"
    | "after_decision"
    | "after_resume"
    | "after_interrupt"
    | "after_timeout"
  planning_round: number
}


⸻

4.22 MISSION_COMPLETED.payload

用途

整个 demand 已满足全局 acceptance criteria，任务结束。

type MissionCompletedPayload = {
  completion_summary: string
  accepted_artifact_ids: string[]
  completed_subgoal_ids: string[]
  finished_at: string
}


⸻

5. 事件到 Payload 的映射表

type EventPayloadMap = {
  USER_INPUT_RECEIVED: UserInputReceivedPayload
  DEMAND_CLARIFICATION_COMPLETED: DemandClarificationCompletedPayload
  PLAN_GENERATED: PlanGeneratedPayload
  SUBGOAL_CREATED: SubgoalCreatedPayload
  SUBGOAL_MARKED_READY: SubgoalMarkedReadyPayload
  EXECUTION_CREATED: ExecutionCreatedPayload
  EXECUTION_DISPATCHED: ExecutionDispatchedPayload
  WORKER_HEARTBEAT_RECEIVED: WorkerHeartbeatReceivedPayload
  WORKER_RESULT_RECEIVED: WorkerResultReceivedPayload
  EXECUTION_TIMEOUT_DETECTED: ExecutionTimeoutDetectedPayload
  VERIFICATION_COMPLETED: VerificationCompletedPayload
  RECONCILIATION_COMPLETED: ReconciliationCompletedPayload
  DECISION_REQUEST_CREATED: DecisionRequestCreatedPayload
  DECISION_RESPONSE_RECEIVED: DecisionResponseReceivedPayload
  USER_PAUSE_REQUESTED: UserPauseRequestedPayload
  USER_RESUME_REQUESTED: UserResumeRequestedPayload
  USER_STOP_EXECUTION_REQUESTED: UserStopExecutionRequestedPayload
  USER_CANCEL_DEMAND_REQUESTED: UserCancelDemandRequestedPayload
  USER_STOP_WORKER_REQUESTED: UserStopWorkerRequestedPayload
  OPS_ALERT_RECEIVED: OpsAlertReceivedPayload
  REPLAN_REQUESTED: ReplanRequestedPayload
  MISSION_COMPLETED: MissionCompletedPayload
}


⸻

6. JSON Schema 落盘建议

如果要把本文件继续拆成真正 JSON Schema 文件，建议生成：
	•	event_payload_user_input_received.schema.json
	•	event_payload_demand_clarification_completed.schema.json
	•	event_payload_plan_generated.schema.json
	•	event_payload_subgoal_created.schema.json
	•	event_payload_execution_created.schema.json
	•	event_payload_execution_dispatched.schema.json
	•	event_payload_worker_result_received.schema.json
	•	event_payload_verification_completed.schema.json
	•	event_payload_decision_request_created.schema.json
	•	event_payload_decision_response_received.schema.json
	•	event_payload_replan_requested.schema.json
	•	event_payload_mission_completed.schema.json

但 v1 实现里，更推荐先在代码层定义 EventPayloadMap 类型和 validator，再统一落到 event store。

⸻

7. v1 冻结结论
	1.	所有事件都使用统一 envelope
	2.	payload 必须有确定字段，不允许业务代码自由拼装
	3.	核心执行事件直接包结构化对象，如 WorkerResult、VerificationResult、DecisionRequest
	4.	Resume 固定为 PAUSED -> READY -> REPLAN_REQUESTED
	5.	UNVERIFIABLE 相关后续动作不在 payload 里临时猜，而由 reconciliation 规则决定

⸻