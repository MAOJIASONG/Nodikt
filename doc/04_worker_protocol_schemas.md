Nodikt Worker 协议 Schema v1

1. 文档目标

本文档定义 Nodikt v1 中 Scheduler 与 Worker Adapter 之间的统一协议。

v1 当前范围：
	•	先适配 codex
	•	先适配 opencode
	•	暂不要求适配 claude_code

目标：
	•	Scheduler 不直接耦合底层 worker 的私有协议
	•	所有 worker 都通过统一的 packet / result / heartbeat / control contract 接入
	•	底层差异由 adapter 层抹平

⸻

2. 协议设计原则

2.1 Scheduler 只面向统一协议

Scheduler 不直接理解：
	•	Codex CLI 私有参数
	•	OpenCode session 私有格式
	•	任意 worker 的私有事件流

Scheduler 只理解：
	•	WorkerRegistration
	•	WorkerDispatchPacket
	•	WorkerHeartbeat
	•	WorkerResult
	•	VerificationInput
	•	WorkerControlCommand

2.2 Worker 是受控执行单元

Worker：
	•	只能围绕当前 SubgoalContract 执行
	•	不能擅自修改主计划
	•	不能越过 constraints
	•	不能超出 budget
	•	安装 skill / 依赖必须触发 review

2.3 Heartbeat 由 Adapter 统一合成

不要求底层 worker 原生支持统一 heartbeat。
Adapter 必须把：
	•	event stream
	•	status poll
	•	process alive 信号
	•	hook / SSE / JSONL 输出
统一折叠成 WorkerHeartbeat

2.4 Worker 结果只代表“执行声明”

WorkerResult 不是最终验收结果。
真正的完成必须经过：
	•	Verifier
	•	Reconciliation

⸻

3. Worker 支持范围（v1）

3.1 支持的 Adapter Type

type WorkerAdapterType =
  | "codex"
  | "opencode"

3.2 预留但暂不实现

type ReservedAdapterType =
  | "claude_code"
  | "custom"

3.3 Runtime Type

type WorkerRuntimeType =
  | "local_command"
  | "http"
  | "websocket"

v1 建议：
	•	Codex: local_command
	•	OpenCode: http 或 local_command + local server

⸻

4. WorkerRegistration

用于 worker 注册与 registry 存储。

type WorkerRegistration = {
  worker_id: string
  name: string
  adapter_type: "codex" | "opencode"
  runtime_type: "local_command" | "http" | "websocket"
  status: "idle" | "busy" | "offline" | "error" | "disabled"
  max_concurrency: number
  capabilities: string[]
  available_skills: string[]
  install_policy: "none" | "allowed_with_review"
  config: WorkerAdapterConfig
  current_execution_ids: string[]
  last_seen_at?: string | null
  last_error?: string | null
  is_enabled: boolean
  created_at: string
  updated_at: string
}

4.1 WorkerAdapterConfig

type WorkerAdapterConfig = {
  workspace_root: string
  command?: string
  args?: string[]
  endpoint?: string
  api_key?: string | null
  env?: Record<string, string>
  timeout_seconds?: number
  metadata?: Record<string, unknown>
}

4.2 字段说明
	•	adapter_type: 当前 worker 属于 codex 或 opencode
	•	runtime_type: 该 adapter 通过什么方式接入
	•	capabilities: 用于 scheduler routing，例如 code_generation, file_edit, command_execution
	•	available_skills: 当前 worker 已可直接使用的 skills
	•	install_policy: v1 推荐只允许 allowed_with_review
	•	workspace_root: 当前 worker 允许操作的根目录

⸻

5. WorkerDispatchPacket

这是 Scheduler 派发给 Worker 的统一任务包。

type WorkerDispatchPacket = {
  schema_version: "v1"

  execution_id: string
  demand_id: string
  subgoal_id: string
  worker_id: string

  clarified_demand: string
  operational_objective: OperationalObjective
  subgoal_contract: SubgoalContract

  context_slice: WorkerContextSlice
  permissions: WorkerPermissions
  reply_protocol: ReplyProtocol

  created_at: string
}

5.1 OperationalObjective

type OperationalObjective = {
  objective: string
  acceptance_criteria: string[]
  constraints: string[]
  non_goals?: string[]
  termination_conditions?: string[]
}

5.2 SubgoalContract

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

5.3 WorkerContextSlice

type WorkerContextSlice = {
  mission_state_summary: string
  relevant_history: string
  relevant_artifacts: ArtifactRef[]
  shared_hints: string[]
  environment_notes: string[]
  skills: SkillRef[]
}

5.4 ArtifactRef

type ArtifactRef = {
  artifact_id: string
  artifact_type: "git_commit" | "pull_request" | "file_bundle" | "structured_output_json"
  backend: "git" | "filesystem"
  uri: string
  metadata?: Record<string, unknown>
  created_at: string
}

5.5 SkillRef

type SkillRef = {
  name: string
  path?: string
  version?: string
  metadata?: Record<string, unknown>
}

5.6 WorkerPermissions

type WorkerPermissions = {
  can_modify_files: boolean
  can_run_commands: boolean
  can_install_dependencies: boolean
  can_open_pr: boolean
}

5.7 ReplyProtocol

type ReplyProtocol = {
  result_schema_version: "v1"
  heartbeat_interval_seconds: number
  execution_timeout_seconds: number
  cadence_hint?: {
    partial_after_steps?: number
    partial_after_minutes?: number
  }
}


⸻

6. WorkerHeartbeat

WorkerHeartbeat 是 Scheduler 判断 worker 是否存活、是否仍在推进当前 execution 的统一信号。

type WorkerHeartbeat = {
  schema_version: "v1"

  worker_id: string
  execution_id?: string | null

  status: "idle" | "running" | "blocked" | "offline" | "error"
  progress_note?: string | null

  source: "synthetic_timer" | "event_stream" | "hook" | "status_poll"
  timestamp: string
}

6.1 设计说明
	•	不要求底层 worker 原生实现 heartbeat
	•	adapter 需要把底层运行状态合成为该结构
	•	progress_note 是可选的，用于 dashboard 与 ops 可观测性
	•	source 用来标明 heartbeat 是怎么来的，便于 debug

6.2 v1 默认值
	•	heartbeat_interval_seconds 由 settings.runtime.heartbeat_interval_seconds 提供
	•	execution_timeout_seconds 由 settings.runtime.execution_timeout_seconds 提供
	•	max_retry_count 由 settings.runtime.max_retry_count 提供
	•	skill_install_scope 由 settings.worker_policy.skill_install_scope 提供

6.3 Codex Heartbeat 策略

推荐：
	•	基于 JSONL / 事件流刷新 last_seen_at
	•	若 30 秒无事件，adapter 仍可基于进程存活发 synthetic heartbeat

6.4 OpenCode Heartbeat 策略

推荐：
	•	基于 session status / SSE event / health endpoint
	•	若 30 秒内无新活动，adapter 仍补一个 synthetic heartbeat

⸻

7. WorkerResult

WorkerResult 是一次 execution 的执行声明结果，不是最终验收结果。

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

7.1 字段说明
	•	worker_status: worker 自己对本轮执行的判断
	•	claimed_outcome: worker 认为自己完成了什么
	•	compressed_history: 本轮执行压缩摘要，不是原始流水日志
	•	produced_artifacts: 本轮产生的产物引用
	•	blocker_reason: 如果阻塞或失败，给出明确原因
	•	suggested_next_step: worker 可以建议，但不能改主计划
	•	adapter_meta: 留给 codex / opencode 的私有元数据

7.2 约束
	•	Worker 不得直接修改 demand objective
	•	Worker 不得通过 suggested_next_step 擅自重写主计划
	•	安装 skill / 依赖场景必须返回 BLOCKED 或 NEED_HELP，等待 review

⸻

8. VerificationInput / VerificationResult

Verifier 输入来源于 execution + worker result + artifacts。

type VerificationInput = {
  execution_id: string
  demand_id: string
  subgoal_id: string
  subgoal_contract: SubgoalContract
  worker_result: WorkerResult
  artifact_evidence: ArtifactRef[]
}

type VerificationResult = {
  schema_version: "v1"

  execution_id: string
  subgoal_id: string
  verified_status: "VERIFIED_DONE" | "PARTIAL" | "FAILED" | "UNVERIFIABLE"
  accepted_artifacts: ArtifactRef[]
  notes: string
  verified_at: string
}

8.1 v1 固定落点
	•	UNVERIFIABLE -> Subgoal=BLOCKED, Execution=FAILED, create DecisionRequest

⸻

9. DecisionRequest / DecisionResponse

9.1 DecisionRequest

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

9.2 DecisionResponse

type DecisionResponse = {
  schema_version: "v1"

  decision_id: string
  action: "Approve" | "Reject" | "ProvideInfo" | "Pause" | "Stop" | "CancelDemand"
  note?: string | null
  payload?: Record<string, unknown>
  responded_at: string
}

9.3 约束
	•	ProvideInfo 只能补充上下文，不能修改 demand objective
	•	执行阶段所有主动通知统一通过 DecisionRequest，不通过聊天消息

⸻

10. WorkerControlCommand

Scheduler 对 adapter / worker 的控制命令。

type WorkerControlCommand = {
  schema_version: "v1"

  command_id: string
  worker_id: string
  execution_id?: string | null
  action: "stop_execution" | "pause_execution" | "resume_execution" | "health_check"
  payload?: Record<string, unknown>
  created_at: string
}

10.1 v1 推荐实现范围
	•	stop_execution
	•	health_check

pause_execution / resume_execution 可先预留，不要求底层 worker 真正支持。

⸻

11. Adapter 统一接口

建议 agent 实现成统一接口：

interface WorkerAdapter {
  register(config: WorkerAdapterConfig): Promise<WorkerRegistration>
  startExecution(packet: WorkerDispatchPacket): Promise<{ execution_id: string }>
  stopExecution(execution_id: string): Promise<void>
  pollStatus(execution_id: string): Promise<WorkerHeartbeat>
  collectResult(execution_id: string): Promise<WorkerResult | null>
  healthCheck(worker_id: string): Promise<WorkerHeartbeat>
}

说明：
	•	pollStatus() 可用于无事件流场景
	•	collectResult() 用于拉模式结果采集
	•	若底层支持 event stream，也可以内部转成 push 再统一落到 scheduler event

⸻

12. Codex Adapter 约束

12.1 输入
	•	优先接收 WorkerDispatchPacket
	•	由 adapter 翻译成 codex 可执行输入格式

12.2 输出
	•	将 codex 事件流 / JSONL / stdout 折叠成：
	•	WorkerHeartbeat
	•	WorkerResult

12.3 私有元数据建议放在 adapter_meta

例如：

{
  run_id?: string,
  session_id?: string,
  raw_event_count?: number
}


⸻

13. OpenCode Adapter 约束

13.1 输入
	•	优先接收 WorkerDispatchPacket
	•	由 adapter 翻译成 opencode 的 session / command / API 输入

13.2 输出
	•	将 opencode session status / SSE event / result 折叠成：
	•	WorkerHeartbeat
	•	WorkerResult

13.3 私有元数据建议放在 adapter_meta

例如：

{
  session_id?: string,
  endpoint?: string,
  raw_status?: string
}


⸻

14. JSON Schema 落盘建议

如果要把本文件再转成真正 JSON Schema 文件，建议拆成：
	•	worker_registration.schema.json
	•	worker_dispatch_packet.schema.json
	•	worker_heartbeat.schema.json
	•	worker_result.schema.json
	•	verification_result.schema.json
	•	decision_request.schema.json
	•	decision_response.schema.json

⸻

15. v1 冻结结论
	1.	v1 先只适配 codex 和 opencode
	2.	Scheduler 只看统一 worker 协议，不看底层私有协议
	3.	Heartbeat 由 adapter 统一合成
	4.	WorkerResult 只是执行声明，不是最终验收
	5.	UNVERIFIABLE -> Subgoal=BLOCKED, Execution=FAILED, create DecisionRequest
	6.	安装 skill / 依赖必须走 review
	7.	安装范围只允许 workspace_only
