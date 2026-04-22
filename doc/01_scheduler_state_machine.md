Nodikt Scheduler 状态机设计 v1
1. 设计目标
Scheduler 是 Nodikt 的唯一控制中枢，但它不是 Agent。
它的本质是：
代码主导的事件驱动状态机（Code-first Event-Driven State Machine）
LLM 仅作为辅助能力被调用，用于：
澄清 Demand
生成/压缩计划摘要
生成 Subgoal 草案
辅助做验证说明
生成人类决策面板文案
LLM 不负责：
决定主流程
决定状态迁移
决定是否派发/暂停/终止
决定是否信任 Worker 结果
2. 调度核心原则
原则 1：Frontier-only Planning
只规划当前最该做的几步，不一次性下发全部深层任务。
原则 2：Code Controls the Loop
主循环由代码状态机控制，LLM 只做辅助生成与理解。
原则 3：Never Trust Worker Claims Without Verification
Worker 的 DONE 不是系统的 DONE，必须经过 Verifier 和 Reconciliation。
原则 4：Human Sovereignty via Explicit Decision Points
需要人类介入时，不通过聊天，而通过显式 Decision Request（CLI 风格选项 + 输入补充信息）。
原则 5：No Mid-execution Demand Mutation in v1
Demand 一旦完成澄清并进入执行，不支持中途改需求继续跑。
如要修改，只能 Pause / Stop / Cancel，再新建 Demand。
3. Scheduler 内部模块
3.1 Interface / Session Manager
职责：
接收用户输入
维护 demand session
维护 tag / session 隔离
把用户动作转换为调度事件
接收用户对 Decision Request 的结构化响应
输入：
Initial Demand
Demand 内消息
Pause / Stop / Cancel / Approve / Reject / ProvideInfo 等动作
输出：
Scheduler Event
Clarification Input
Decision Response
3.2 Planner
职责：
在澄清阶段生成 Clarified Demand
将 Clarified Demand 编译为 Operational Objective
基于当前记忆和 artifact evidence 构建 / 更新 dependency graph
只产出当前 frontier subgoals
输入：
Clarified Demand
MissionState
EpisodicTrace
LessonsOrPolicy
ArtifactEvidence
WorkerHistory Summary
输出：
Operational Objective
Updated Dependency Graph
Frontier SubgoalContracts
Updated High-level Summary
3.3 Dispatcher
职责：
根据 subgoal 选择合适 worker
检查 worker busy/free、能力、资源、权限
构建 WorkerContext
派发执行
处理中断 / 停止 / 暂停
输入：
Frontier SubgoalContracts
Worker Registry
Worker Status
输出：
Execution Records
WorkerDispatchPacket
Interrupt Signal
3.4 Verifier
职责：
校验 worker 交付结果是否真实存在
校验 success criteria 是否满足
校验 claimed_outcome 与 artifact evidence 是否一致
决定 VERIFIED_DONE / PARTIAL / FAILED / UNVERIFIABLE
输入：
WorkerResult
ArtifactEvidence
SubgoalContract
输出：
VerificationResult
3.5 Reconciliation
职责：
接受 / 拒绝 artifact
更新 subgoal 状态
更新 MissionState / EpisodicTrace / LessonsOrPolicy
决定是否触发下一轮 replan
输入：
VerificationResult
WorkerResult
Existing State
输出：
Updated State
Replan Trigger
Decision Request（如需要）
3.6 Memory Manager
职责：
管理三层记忆
控制长期记忆写入规则
压缩执行轨迹
为 Planner 提供最新有效摘要
输入：
Verified Facts
Worker Summary
Accepted Artifacts
输出：
MissionState
EpisodicTrace
LessonsOrPolicy
4. 核心对象
4.1 Demand
type Demand = {
  demand_id: string
  title: string
  initial_input: string
  clarified_demand?: string
  operational_objective?: OperationalObjective
  state: DemandState
  autonomy_level: "L0" | "L1" | "L2" | "L3" | "L4"
  acceptance_criteria: string[]
  constraints: string[]
  created_at: string
  updated_at: string
}
4.2 OperationalObjective
type OperationalObjective = {
  objective: string
  acceptance_criteria: string[]
  constraints: string[]
  non_goals?: string[]
  termination_conditions?: string[]
}
4.3 SubgoalContract
type SubgoalContract = {
  subgoal_id: string
  demand_id: string
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
  deliverables: string[]
  dependencies: string[]
  priority: number
  state: SubgoalState
}
4.4 WorkerContext
type WorkerContext = {
  clarified_demand: string
  operational_objective: OperationalObjective
  subgoal_contract: SubgoalContract
  mission_state_slice: string
  relevant_artifacts: ArtifactRef[]
  shared_hints: string[]
  permissions: {
    can_modify_files: boolean
    can_run_commands: boolean
    can_install_dependencies: boolean
    can_open_pr: boolean
  }
}
4.5 WorkerResult
type WorkerResult = {
  execution_id: string
  worker_id: string
  worker_status: "DONE" | "BLOCKED" | "FAILED" | "NEED_HELP" | "PARTIAL"
  claimed_outcome?: string
  compressed_history: string
  produced_artifacts: ArtifactRef[]
  blocker_reason?: {
    code: string
    message: string
  }
  suggested_next_step?: string
  budget_used?: {
    steps?: number
    duration_ms?: number
    estimated_cost_usd?: number
  }
}
4.6 VerificationResult
type VerificationResult = {
  execution_id: string
  subgoal_id: string
  verified_status: "VERIFIED_DONE" | "PARTIAL" | "FAILED" | "UNVERIFIABLE"
  accepted_artifacts: ArtifactRef[]
  notes: string
}
4.7 DecisionRequest
type DecisionRequest = {
  decision_id: string
  demand_id: string
  subgoal_id?: string
  execution_id?: string
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
5. 三层记忆
5.1 MissionState
只放客观事实：
type MissionState = {
  demand_id: string
  current_phase: "ALIGNMENT" | "PLANNING" | "EXECUTION" | "REVIEW" | "COMPLETED" | "FAILED" | "CANCELLED"
  dependency_graph: DependencyGraph
  active_subgoals: string[]
  completed_subgoals: string[]
  failed_subgoals: string[]
  blocked_subgoals: string[]
  accepted_artifacts: ArtifactRef[]
  global_risks: string[]
  termination_conditions: string[]
}
5.2 EpisodicTrace
只放最近执行轨迹：
type EpisodicTrace = {
  recent_events: string[]
  recent_worker_summaries: Array<{
    worker_id: string
    subgoal_id: string
    summary: string
  }>
  latest_verifier_notes: string[]
}
5.3 LessonsOrPolicy
只放可复用经验：
type LessonsOrPolicy = {
  reusable_skills: string[]
  routing_hints: string[]
  failure_patterns: string[]
  strategy_notes: string[]
}
写入规则：
MissionState：只写验证过的客观事实
EpisodicTrace：只写最近轨迹摘要
LessonsOrPolicy：只写可复用经验，不写临时猜测
6. 状态机
6.1 DemandState
type DemandState =
  | "PENDING_ALIGNMENT"
  | "READY"
  | "ACTIVE"
  | "PENDING_DECISION"
  | "PAUSED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
说明：
PENDING_ALIGNMENT: 澄清阶段
READY: 澄清完成，可开始 planning/dispatch
ACTIVE: 已有执行循环正在推进
PENDING_DECISION: 等待人类在决策面板处理事项
PAUSED: 被用户或系统暂停
COMPLETED: 全局验收完成
FAILED: 整体不可恢复失败
CANCELLED: 被用户取消
6.2 SubgoalState
type SubgoalState =
  | "PLANNED"
  | "READY"
  | "DISPATCHED"
  | "EXECUTING"
  | "BLOCKED"
  | "VERIFYING"
  | "DONE"
  | "FAILED"
  | "CANCELLED"
6.3 ExecutionState
type ExecutionState =
  | "QUEUED"
  | "RUNNING"
  | "WAITING_RESULT"
  | "VERIFYING"
  | "DONE"
  | "FAILED"
  | "INTERRUPTED"
  | "TIMEOUT"
  | "CANCELLED"
7. 事件系统
7.1 EventType
type EventType =
  | "USER_INPUT_RECEIVED"
  | "DEMAND_CLARIFIED"
  | "PLAN_READY"
  | "SUBGOAL_CREATED"
  | "SUBGOAL_READY"
  | "EXECUTION_DISPATCHED"
  | "WORKER_HEARTBEAT"
  | "WORKER_RESULT_RECEIVED"
  | "VERIFICATION_COMPLETED"
  | "DECISION_REQUEST_CREATED"
  | "DECISION_RESPONSE_RECEIVED"
  | "USER_PAUSE_REQUESTED"
  | "USER_STOP_REQUESTED"
  | "USER_CANCEL_REQUESTED"
  | "EXECUTION_TIMEOUT"
  | "OPS_ALERT"
  | "REPLAN_REQUESTED"
7.2 Event 结构
type SchedulerEvent = {
  event_id: string
  event_type: EventType
  demand_id?: string
  subgoal_id?: string
  execution_id?: string
  payload: Record<string, unknown>
  created_at: string
}
8. 主循环
8.1 Clarification Phase
用户输入 Initial Demand
Interface 写入 USER_INPUT_RECEIVED
Scheduler 调 LLM 做澄清
得到 Clarified Demand
编译为 Operational Objective
Demand PENDING_ALIGNMENT -> READY
8.2 Planning Phase
读取 MissionState / EpisodicTrace / LessonsOrPolicy / ArtifactEvidence
Planner 更新 dependency graph
只选择 frontier subgoals
生成 SubgoalContracts
写入 PLAN_READY / SUBGOAL_CREATED
8.3 Dispatch Phase
Dispatcher 选 worker
构造 WorkerContext
生成 Execution
写入 EXECUTION_DISPATCHED
Subgoal READY -> DISPATCHED -> EXECUTING
8.4 Execution Return Phase
Worker 在以下任一条件满足时返回：
DONE
BLOCKED
FAILED
NEED_HELP
PARTIAL
k steps reached
timeout
token/cost/action budget exhausted
8.5 Verification Phase
收到 WorkerResult
写入 WORKER_RESULT_RECEIVED
Verifier 检查 artifacts / filesystem / git / success criteria
输出 VerificationResult
写入 VERIFICATION_COMPLETED
8.6 Reconciliation Phase
接受或拒绝 artifact
更新 SubgoalState
更新 MissionState / EpisodicTrace / LessonsOrPolicy
判断是否需要 Decision Request
判断是否需要 Replan
8.7 Replan Phase
若全局 acceptance criteria 满足 -> Demand COMPLETED
若仍有可执行 frontier -> 进入下一轮 dispatch
若需要人类拍板 -> Demand PENDING_DECISION
若整体不可恢复 -> Demand FAILED
9. 状态迁移规则
9.1 Demand 关键迁移
PENDING_ALIGNMENT -> READY：Clarified Demand 形成
READY -> ACTIVE：至少一个 frontier subgoal 被派发
ACTIVE -> PENDING_DECISION：创建了 OPEN 的 DecisionRequest
PENDING_DECISION -> ACTIVE：用户完成决策，且允许继续
ACTIVE -> PAUSED：用户 Pause
PAUSED -> ACTIVE：用户 Resume
ACTIVE -> COMPLETED：全局验收通过
ACTIVE -> FAILED：不可恢复失败
* -> CANCELLED：用户 Cancel
9.2 Subgoal 关键迁移
PLANNED -> READY
READY -> DISPATCHED
DISPATCHED -> EXECUTING
EXECUTING -> BLOCKED
EXECUTING -> VERIFYING
VERIFYING -> DONE
VERIFYING -> FAILED
* -> CANCELLED
9.3 不允许的迁移示例
COMPLETED -> ACTIVE
CANCELLED -> ACTIVE
FAILED -> EXECUTING
DONE -> EXECUTING
10. 决策面板触发规则
v1 采用：硬规则优先 + LLM 辅助文案
必触发 Decision Request
缺失必要信息
缺失权限
安装 skill / 依赖
Worker 返回 BLOCKED / NEED_HELP
Verifier 输出 UNVERIFIABLE
autonomy level 要求审批
高风险写操作
Ops 报警要求人类确认
不通过聊天触发
执行阶段所有主动通知，一律通过 DecisionRequest 进入前端人类决策面板。
11. Interrupt 规则（v1）
v1 支持：
Pause Demand
Stop 当前执行
Cancel Demand
Stop 某个 Worker
调整优先级（不改变 objective）
v1 不支持：
执行中修改 Clarified Demand
执行中切换目标方向
执行中插入改变 objective 的新约束
如果用户想改需求：
Stop / Cancel 当前 Demand
基于当前结果新建 Demand
12. Planner 与 LLM 的边界
代码负责：
什么时候 plan
什么时候 dispatch
什么时候 replan
什么时候进 decision
什么时候 fail / complete
LLM 负责：
澄清文字
计划文字草案
summary 压缩
suggested subgoals
decision prompt 文案
即：
LLM 可建议，代码做决定。
13. Worker Routing 规则
Dispatcher 只关心：
worker 是否 busy/free
是否有对应能力
是否有对应环境 / 权限 / 资源
是否允许并发
这本质上是：
worker capacity scheduling
而不是 shared memory locking。
14. 持久化建议
v1 使用 JSON：
demands.json
subgoals.json
executions.json
workers.json
decisions.json
events.json
memory.json
建议写入顺序：
append event
update snapshot
push websocket event
15. v1 先实现的最短闭环
创建 Demand
Clarify 得到 Clarified Demand
Planner 生成 frontier subgoal
Dispatcher 派发给 worker
Worker 返回 WorkerResult
Verifier 检查
Reconciliation 更新状态
若需要，生成 DecisionRequest
否则 replan / complete
16. 后续实现建议
下一步应继续产出两份文档：
Scheduler 事件表 / 状态迁移表（逐条枚举）
Scheduler 伪代码与目录结构设计