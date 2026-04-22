Nodikt Backend Module Boundaries v1

1. 文档目标

本文档定义 Nodikt v1 后端的模块边界、职责、输入输出、依赖方向与禁止事项。

目标：
	•	防止 Claude Code / Codex 把后端写成一锅粥
	•	让 Scheduler 维持“代码主导状态机”而不是散落逻辑
	•	明确哪些模块可以直接读写 JSON，哪些不能
	•	明确哪些模块负责状态迁移，哪些只负责纯计算/纯适配

适用前提：
	•	v1 使用 JSON 文件存储
	•	核心状态迁移只能通过事件 handler 发生
	•	执行阶段不支持修改 demand objective
	•	当前优先支持 codex 与 opencode worker adapters

⸻

2. 总体架构分层

推荐后端按以下层次组织：

Layer A：Interface Layer

负责对外暴露接口：
	•	REST API
	•	WebSocket
	•	Human Decision Panel 请求入口

Layer B：Application Layer

负责业务流程编排：
	•	Scheduler handlers
	•	Planner
	•	Dispatcher
	•	Verifier
	•	Reconciliation
	•	Decision service
	•	Memory manager

Layer C：Infrastructure Layer

负责底层实现：
	•	JSON repositories
	•	Event store
	•	Worker adapters
	•	File system / git evidence readers
	•	Time / timeout monitor

Layer D：Domain Types / Schemas

负责类型、schema、枚举、事件 payload map。

⸻

3. 模块总表

建议至少拆成以下模块：
	1.	domain
	2.	repositories
	3.	event_bus
	4.	handlers
	5.	planner
	6.	dispatcher
	7.	verifier
	8.	reconciliation
	9.	decision
	10.	memory_manager
	11.	worker_adapters
	12.	ops_monitor
	13.	ws_broadcaster
	14.	api

⸻

4. 模块边界详细说明

4.1 domain

职责

定义纯领域概念：
	•	枚举
	•	类型
	•	schema
	•	event payload map
	•	工具级纯函数（不带 IO）

输入
	•	无运行时输入依赖

输出
	•	DemandState
	•	SubgoalState
	•	ExecutionState
	•	DecisionStatus
	•	EventType
	•	WorkerDispatchPacket
	•	WorkerResult
	•	VerificationResult
	•	DecisionRequest
	•	DecisionResponse
	•	JSON schema / validator

允许依赖
	•	无或极少第三方库（如 schema validator）

禁止事项
	•	不能读写 JSON 文件
	•	不能调用 LLM
	•	不能调用 worker
	•	不能做网络 IO

⸻

4.2 repositories

职责

封装所有 JSON 文件读写：
	•	demands.json
	•	subgoals.json
	•	executions.json
	•	workers.json
	•	decisions.json
	•	events.json
	•	memory.json
	•	settings.json

输入
	•	领域对象
	•	查询条件

输出
	•	快照对象
	•	持久化结果

推荐拆分
	•	DemandRepository
	•	SubgoalRepository
	•	ExecutionRepository
	•	WorkerRepository
	•	DecisionRepository
	•	MemoryRepository
	•	SettingsRepository
	•	EventStoreRepository

允许依赖
	•	domain
	•	文件系统库

禁止事项
	•	不允许决定状态迁移
	•	不允许做 planning / dispatch / verification
	•	不允许直接发 websocket
	•	不允许拼业务事件链

特别约束

repositories 是存取层，不是业务层。

⸻

4.3 event_bus

职责

统一事件分发与事件处理入口。

输入
	•	SchedulerEvent

输出
	•	调度到对应 handler
	•	统一错误捕获
	•	可选的事件日志钩子

允许依赖
	•	domain
	•	handlers
	•	repositories/event_store

禁止事项
	•	不直接修改 demand/subgoal/execution
	•	不内嵌 planner / dispatcher 逻辑

说明

event_bus 负责：
	•	根据 event_type 路由到 handler
	•	保证所有状态迁移走统一入口

⸻

4.4 handlers

职责

按事件类型处理业务主流程，是 Scheduler 的实际控制面。

推荐子模块
	•	onUserInput
	•	onClarificationCompleted
	•	onPlanGenerated
	•	onSubgoalCreated
	•	onSubgoalReady
	•	onExecutionCreated
	•	onExecutionDispatched
	•	onWorkerHeartbeat
	•	onWorkerResult
	•	onVerificationCompleted
	•	onReconciliationCompleted
	•	onDecisionCreated
	•	onDecisionResolved
	•	onPauseDemand
	•	onResumeDemand
	•	onStopExecution
	•	onCancelDemand
	•	onStopWorker
	•	onOpsAlert
	•	onReplanRequested
	•	onMissionCompleted

输入
	•	SchedulerEvent
	•	repositories 查询结果
	•	planner / verifier / dispatcher 等 service 的输出

输出
	•	新事件
	•	快照更新
	•	decision request
	•	websocket 广播触发

允许依赖
	•	domain
	•	repositories
	•	planner
	•	dispatcher
	•	verifier
	•	reconciliation
	•	decision
	•	memory_manager
	•	worker_adapters
	•	ws_broadcaster

禁止事项
	•	不应直接手写大量 schema
	•	不应在多个 handler 中复制状态迁移逻辑
	•	不应绕过 event store 直接偷偷改状态

核心要求

所有关键状态变更必须：
	1.	append event
	2.	update snapshot
	3.	push websocket

⸻

4.5 planner

职责

负责：
	•	澄清 demand（调用 LLM 生成文字结果）
	•	生成 OperationalObjective
	•	生成 high-level summary
	•	更新 dependency graph
	•	选择 frontier subgoals
	•	生成 SubgoalContract

输入
	•	Clarified Demand
	•	MissionState
	•	EpisodicTrace
	•	LessonsOrPolicy
	•	ArtifactEvidence
	•	Worker history summary

输出
	•	OperationalObjective
	•	SubgoalContract[]
	•	dependency_graph_snapshot
	•	high_level_summary

允许依赖
	•	domain
	•	LLM client
	•	memory_manager（只读接口）
	•	artifact evidence reader

禁止事项
	•	不直接写 JSON 快照
	•	不直接派发 worker
	•	不直接改变 demand state
	•	不直接创建 decision request（由 handler 决定）

说明

Planner 是“生成建议与计划”的模块，不是状态机本体。

⸻

4.6 dispatcher

职责

负责：
	•	worker routing
	•	capacity scheduling
	•	生成 WorkerDispatchPacket
	•	调用 worker adapter 启动 execution
	•	发送 stop / health check 等控制命令

输入
	•	SubgoalContract
	•	worker registry
	•	worker status
	•	settings/default permissions

输出
	•	Execution 记录初始信息
	•	WorkerDispatchPacket
	•	adapter 调用结果

允许依赖
	•	domain
	•	repositories/workers
	•	worker_adapters
	•	settings

禁止事项
	•	不做 planning
	•	不做 verification
	•	不直接修改 MissionState
	•	不决定整体 demand 完成/失败

⸻

4.7 verifier

职责

负责：
	•	校验 deliverables 是否存在
	•	校验 artifact evidence 是否可读
	•	校验 success criteria 是否满足
	•	比对 worker claimed outcome 与实际 evidence
	•	输出 VerificationResult

输入
	•	SubgoalContract
	•	WorkerResult
	•	artifact evidence

输出
	•	VerificationResult

允许依赖
	•	domain
	•	artifact readers
	•	file system / git readers
	•	可选 LLM verifier helper（只做说明/辅助）

禁止事项
	•	不直接更新 subgoal state
	•	不直接写 decision request
	•	不直接 replan

说明

Verifier 只判定“验证结果”，不负责系统后续动作。

⸻

4.8 reconciliation

职责

负责：
	•	接受/拒绝 artifacts
	•	更新 subgoal / execution 最终落点
	•	更新 MissionState / EpisodicTrace / LessonsOrPolicy
	•	决定下一步建议：
	•	create decision
	•	request replan
	•	complete mission
	•	no-op

输入
	•	VerificationResult
	•	WorkerResult
	•	当前 demand/subgoal/execution/memory 快照

输出
	•	reconciliation result
	•	memory updates
	•	next action recommendation

允许依赖
	•	domain
	•	memory_manager

禁止事项
	•	不直接派发 worker
	•	不直接调 LLM 做 planning
	•	不直接发 websocket

说明

Reconciliation 是“落状态 + 更新记忆 + 给出建议”，不是完整 handler。

⸻

4.9 decision

职责

负责：
	•	创建 DecisionRequest
	•	校验 DecisionResponse
	•	把用户决策转换为系统后续动作建议

输入
	•	触发原因
	•	决策面板选项
	•	用户 response

输出
	•	DecisionRequest
	•	DecisionResponse
	•	决策解析结果

允许依赖
	•	domain
	•	repositories/decisions

禁止事项
	•	不直接改 demand state
	•	不直接 replan
	•	不直接停 worker

说明

Decision 模块是“决策对象管理”，真正状态变化仍由 handler 执行。

⸻

4.10 memory_manager

职责

负责：
	•	维护 MissionState
	•	维护 EpisodicTrace
	•	维护 LessonsOrPolicy
	•	控制写入规则
	•	提供 planner 需要的压缩摘要

输入
	•	accepted artifacts
	•	verified facts
	•	worker summary
	•	verifier notes

输出
	•	updated memory record
	•	summary strings

允许依赖
	•	domain
	•	repositories/memory

禁止事项
	•	不直接派发 worker
	•	不直接做状态迁移
	•	不直接调 UI / websocket

关键原则
	•	MissionState 只存客观事实
	•	EpisodicTrace 只存最近轨迹
	•	LessonsOrPolicy 只存可复用经验

⸻

4.11 worker_adapters

职责

抹平底层 worker 差异：
	•	codex
	•	opencode

推荐子模块
	•	base_adapter
	•	codex_adapter
	•	opencode_adapter

输入
	•	WorkerDispatchPacket
	•	WorkerControlCommand

输出
	•	WorkerHeartbeat
	•	WorkerResult
	•	health check 结果

允许依赖
	•	domain
	•	外部 CLI / HTTP / WebSocket client

禁止事项
	•	不直接改 demand/subgoal/execution
	•	不直接做 replan
	•	不直接创建 decision request

说明

adapter 只做协议翻译，不做业务决策。

⸻

4.12 ops_monitor

职责

负责：
	•	heartbeat 超时检测
	•	execution timeout 检测
	•	worker 健康检查
	•	provider 健康检查
	•	生成 OPS_ALERT_RECEIVED 或 EXECUTION_TIMEOUT_DETECTED

输入
	•	workers / executions / settings / timestamps

输出
	•	ops events

允许依赖
	•	domain
	•	repositories
	•	worker_adapters

禁止事项
	•	不直接改 demand state
	•	不直接 replan

⸻

4.13 ws_broadcaster

职责

负责把已发生的事件和最新快照广播给前端。

输入
	•	已处理完成的事件
	•	更新后的 snapshot 数据

输出
	•	websocket 消息

允许依赖
	•	domain
	•	repositories（只读）

禁止事项
	•	不做业务判断
	•	不做状态迁移

说明

前端展示是结果消费者，不反向决定状态机逻辑。

⸻

4.14 api

职责

提供 REST API / HTTP endpoints：
	•	dashboard
	•	demands
	•	demand messages
	•	workers
	•	decisions
	•	settings

输入
	•	HTTP 请求

输出
	•	JSON 响应
	•	触发 scheduler events

允许依赖
	•	domain
	•	repositories
	•	event_bus

禁止事项
	•	不直接执行业务核心逻辑
	•	不直接改 snapshot
	•	不直接调用 planner/dispatcher 绕过事件机制

⸻

5. 依赖方向（必须遵守）

推荐依赖方向：

a pi / ws
  -> event_bus
    -> handlers
      -> planner / dispatcher / verifier / reconciliation / decision / memory_manager
      -> repositories
      -> worker_adapters
      -> ws_broadcaster

domain
  <- 被所有模块依赖

repositories
  <- 被 application 层调用
  -> 不反向依赖 handlers/planner/dispatcher

硬规则
	•	repositories 不能依赖 handlers
	•	planner 不能依赖 dispatcher
	•	verifier 不能依赖 planner
	•	worker_adapters 不能依赖 handlers
	•	api 不能直接绕过 event_bus 改状态

⸻

6. 状态迁移控制规则

唯一允许状态迁移的地方

状态迁移只能发生在：
	•	handlers
	•	或 handler 调用的、明确返回“新状态建议”的 application service 后，由 handler 落库

明确禁止的地方

以下模块禁止直接改 demand/subgoal/execution 状态：
	•	planner
	•	verifier
	•	worker_adapters
	•	memory_manager
	•	repositories
	•	api
	•	ws_broadcaster

标准写法
	1.	handler 收到 event
	2.	handler 读取当前快照
	3.	handler 调用 planner/verifier/reconciliation 等纯业务模块
	4.	handler 决定状态变化
	5.	handler append event
	6.	handler 更新 snapshot
	7.	handler 通知 websocket

⸻

7. 推荐目录结构

server/
  src/
    domain/
      types/
      schemas/
      enums/
      event-payload-map.ts

    repositories/
      demands.repository.ts
      subgoals.repository.ts
      executions.repository.ts
      workers.repository.ts
      decisions.repository.ts
      memory.repository.ts
      settings.repository.ts
      events.repository.ts

    event_bus/
      event-bus.ts
      event-dispatcher.ts

    handlers/
      on-user-input.ts
      on-clarification-completed.ts
      on-plan-generated.ts
      on-subgoal-created.ts
      on-subgoal-ready.ts
      on-execution-created.ts
      on-execution-dispatched.ts
      on-worker-heartbeat.ts
      on-worker-result.ts
      on-verification-completed.ts
      on-reconciliation-completed.ts
      on-decision-created.ts
      on-decision-resolved.ts
      on-pause-demand.ts
      on-resume-demand.ts
      on-stop-execution.ts
      on-cancel-demand.ts
      on-stop-worker.ts
      on-ops-alert.ts
      on-replan-requested.ts
      on-mission-completed.ts

    planner/
      clarify-demand.ts
      build-operational-objective.ts
      generate-frontier-subgoals.ts
      summarize-high-level-state.ts

    dispatcher/
      select-worker.ts
      build-dispatch-packet.ts
      dispatch-execution.ts
      stop-execution.ts

    verifier/
      verify-artifacts.ts
      verify-subgoal-result.ts

    reconciliation/
      reconcile-result.ts
      choose-next-action.ts

    decision/
      create-decision-request.ts
      resolve-decision-response.ts

    memory_manager/
      update-mission-state.ts
      update-episodic-trace.ts
      update-lessons-or-policy.ts
      build-planner-summary.ts

    worker_adapters/
      base-adapter.ts
      codex-adapter.ts
      opencode-adapter.ts

    ops_monitor/
      heartbeat-monitor.ts
      timeout-monitor.ts
      provider-health.ts

    ws_broadcaster/
      websocket-server.ts
      broadcast-event.ts

    api/
      routes/
      controllers/
      dto/

    app.ts
    index.ts


⸻

8. Handler 输入输出约束

每个 handler 推荐遵循同一签名风格：

type HandlerContext = {
  repositories: Repositories
  services: Services
  settings: Settings
}

type HandlerResult = {
  emitted_events?: SchedulerEvent[]
  snapshot_updates?: Array<{
    entity: "demand" | "subgoal" | "execution" | "decision" | "memory" | "worker"
    entity_id: string
  }>
  websocket_notifications?: Array<Record<string, unknown>>
}

async function handleX(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult>

好处
	•	agent 容易统一生成 handler 模板
	•	所有 handler 行为风格一致
	•	便于测试

⸻

9. 测试边界建议

单元测试重点
	•	planner
	•	verifier
	•	reconciliation
	•	decision
	•	memory_manager

这些应该尽量写成纯逻辑模块，便于无 IO 测试。

集成测试重点
	•	handlers + repositories + event_bus
	•	worker_adapters
	•	api -> event_bus -> handler -> repository -> websocket

⸻

10. v1 冻结结论
	1.	后端必须按模块拆开，不允许把 scheduler 写成单文件巨类
	2.	状态迁移只能通过 handler 落地
	3.	planner / verifier / adapter / memory manager 都不能直接改状态
	4.	repositories 只做存取，不做业务判断
	5.	api 只能发事件，不直接推进业务流程
	6.	codex / opencode 适配逻辑放在 worker_adapters
	7.	事件驱动主循环由 event_bus + handlers 组成

⸻