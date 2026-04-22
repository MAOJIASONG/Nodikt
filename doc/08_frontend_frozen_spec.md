Nodikt Agent Codegen Brief v1

1. 目标

你正在为 Nodikt v1 生成后端与最小可用前端骨架代码。

本项目的核心不是“聊天 Agent”，而是：

代码主导的事件驱动状态机 + rolling planning + worker execution + verifier + decision panel

你必须严格遵守现有架构文档，不要擅自发明新的主流程、对象模型或 UI 交互。

⸻

2. v1 范围（冻结）

2.1 主要目标

实现一个最小可运行的单机版 Nodikt v1，包含：
	•	Demand 创建与澄清
	•	Scheduler 事件驱动状态机
	•	frontier-only planning
	•	Worker 调度与执行
	•	Verifier 校验
	•	Reconciliation 更新状态与记忆
	•	Human Decision Panel 所需的 decision request / response 机制
	•	Dashboard / Workers / Settings 三入口前端骨架
	•	JSON 文件存储
	•	WebSocket 实时更新

2.2 v1 不做
	•	支付 / 下单类真实外部操作
	•	浏览器自动化
	•	多模态输入
	•	语音输入
	•	Worker 自动创建新 Worker
	•	Skill 自进化
	•	本地模型 fallback 真正落地
	•	跨设备 Worker 自动发现
	•	执行中修改 Demand 目标
	•	全局万能聊天框

2.3 v1 当前 worker 范围

只支持：
	•	codex
	•	opencode

暂不要求：
	•	claude_code
	•	其他 custom worker

⸻

3. 绝对不可违反的架构规则

规则 1：Scheduler 不是 Agent

Scheduler 必须实现为：
	•	代码主导的事件驱动状态机
	•	不是自由自治的聊天 Agent
	•	不是让 LLM 直接决定主流程

LLM 只允许用于：
	•	澄清 demand
	•	生成 planning 文案/草案
	•	生成 summary
	•	生成 decision prompt 文案

LLM 不允许直接决定：
	•	状态迁移
	•	是否派发
	•	是否完成
	•	是否失败
	•	是否信任 worker 结果

规则 2：所有状态迁移都必须经过 event handler

不能在任意 service / repository / adapter 里偷偷改：
	•	demand state
	•	subgoal state
	•	execution state
	•	decision status

规则 3：先记事件，再改快照，再推前端

所有关键状态变化必须遵守：
	1.	append event to events.json
	2.	update snapshot json
	3.	websocket broadcast

规则 4：执行阶段不支持修改 Demand 目标

一旦 demand 已澄清并开始生成/执行 subgoal：
	•	不允许修改 objective
	•	不允许切换目标方向
	•	不允许插入改变目标语义的新约束

若用户想改：
	•	pause / stop / cancel 当前 demand
	•	再新建一个 demand

规则 5：执行阶段主动通知人类不走聊天框

所有需要用户拍板的事项，都必须通过：
	•	DecisionRequest
	•	Human Decision Panel

不要把执行阶段的 review / blocked / permission 请求做成聊天消息驱动。

规则 6：Never trust worker claims without verification

WorkerResult.worker_status = DONE 不代表系统完成。
必须经过：
	•	Verifier
	•	Reconciliation

固定规则：
	•	UNVERIFIABLE -> Subgoal=BLOCKED, Execution=FAILED, create DecisionRequest

规则 7：Resume 固定策略

恢复 demand 时固定为：
	•	PAUSED -> READY -> REPLAN_REQUESTED

不要直接 PAUSED -> ACTIVE。

⸻

4. 前端冻结要求

前端设计已经冻结，不允许随意改方向。

4.1 顶部入口

只保留：
	•	Dashboard
	•	Workers
	•	Settings

4.2 Dashboard
	•	中间展示所有 demand
	•	可新建 demand
	•	可删除 demand
	•	点进 demand 后进入详情模式

4.3 Demand 详情模式
	•	左侧显示所有 demand sidebar
	•	中间只显示当前 demand 的内容：
	•	demand 基础信息
	•	overall plan
	•	current frontier subgoals
	•	worker runtime
	•	decision panel
	•	event timeline
	•	demand 内部对话（主要用于澄清阶段）

4.4 没有全局聊天框
	•	不要生成 project/conversation-first 的前端
	•	聊天只属于某个 demand

4.5 执行阶段不支持改需求
	•	前端不能提供“执行中直接改 demand 目标”的主按钮
	•	Decision Panel 中 ProvideInfo 只能补充上下文，不能改 objective

⸻

5. 后端模块必须按边界拆分

必须按以下模块组织代码，不要写成单文件巨类：
	•	domain
	•	repositories
	•	event_bus
	•	handlers
	•	planner
	•	dispatcher
	•	verifier
	•	reconciliation
	•	decision
	•	memory_manager
	•	worker_adapters
	•	ops_monitor
	•	ws_broadcaster
	•	api

特别要求
	•	repositories 只做 JSON 存取
	•	planner 不直接改状态
	•	verifier 不直接改状态
	•	worker_adapters 不直接改状态
	•	api 不绕过 event_bus 直接推进业务

⸻

6. 目录结构要求

请优先按如下目录结构生成：

server/
  src/
    domain/
    repositories/
    event_bus/
    handlers/
    planner/
    dispatcher/
    verifier/
    reconciliation/
    decision/
    memory_manager/
    worker_adapters/
    ops_monitor/
    ws_broadcaster/
    api/
    app.ts
    index.ts

前端如果生成，也应保持轻量，不要擅自扩成复杂多页面产品。

⸻

7. 数据与协议必须遵守现有文档

生成代码时必须严格遵守已有 schema 文档：
	•	Demand / Subgoal / Execution / Worker / Decision / Event / Memory / Settings schema
	•	Worker protocol schema
	•	Event payload schema

不要自行新增核心字段，除非是：
	•	明确的非核心 metadata
	•	不影响现有 schema 的可选字段

如果要新增字段，优先加到：
	•	metadata
	•	adapter_meta

⸻

8. worker adapter 实现要求

8.1 当前只实现
	•	codex_adapter
	•	opencode_adapter

8.2 必须实现统一 adapter contract

至少提供：
	•	register(config)
	•	startExecution(packet)
	•	stopExecution(execution_id)
	•	pollStatus(execution_id)
	•	collectResult(execution_id)
	•	healthCheck(worker_id)

8.3 heartbeat 规则

不要假设底层 worker 原生支持统一 heartbeat。
adapter 必须合成：
	•	WorkerHeartbeat

固定默认值：

以下值不得硬编码在 handler / adapter / ops_monitor 中，必须从 settings.json 读取：
	•	settings.runtime.heartbeat_interval_seconds
	•	settings.runtime.execution_timeout_seconds
	•	settings.runtime.max_retry_count
	•	settings.worker_policy.skill_install_scope

8.4 skill 安装规则
	•	skill 安装必须 review
	•	安装范围固定：workspace_only
	•	不允许全局安装

⸻

9. 最小实现闭环（必须先打通）

第一轮生成代码时，必须优先打通这条链路：
	1.	创建 Demand
	2.	澄清 Demand，得到 Clarified Demand
	3.	Planner 生成 frontier subgoal
	4.	Dispatcher 选择 worker 并创建 execution
	5.	Worker adapter 返回 WorkerResult
	6.	Verifier 校验
	7.	Reconciliation 更新状态与记忆
	8.	若需要，创建 DecisionRequest
	9.	否则继续 replan 或完成 mission

如果这个闭环还没打通，不要先做复杂增强功能。

⸻

10. 第一轮生成优先顺序

P0：必须先生成
	1.	domain 下的 types / enums / schema validators
	2.	repositories 下的 JSON repository
	3.	event_bus 基础路由
	4.	handlers 骨架
	5.	planner 最小版
	6.	dispatcher 最小版
	7.	verifier 最小版
	8.	reconciliation 最小版
	9.	decision 最小版
	10.	memory_manager 最小版
	11.	codex_adapter
	12.	opencode_adapter
	13.	api 路由骨架
	14.	ws_broadcaster

P1：后补
	•	更丰富的 ops monitor
	•	更复杂的 planner summary
	•	更完整的 worker health 分析
	•	更丰富的前端展示

⸻

11. 编码风格要求

11.1 强类型
	•	优先生成 TypeScript
	•	优先生成清晰的 domain types
	•	尽量避免 any

11.2 handler 风格统一

每个 handler 建议保持统一签名：

async function handleX(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult>

11.3 repository 风格统一

repository 只做：
	•	load
	•	get by id
	•	list
	•	save all / upsert / delete

不要把业务逻辑埋进去。

11.4 先最小可用，再扩展

先把最短闭环跑通，不要一开始实现所有高级功能。

⸻

12. 明确禁止生成的错误方向

不要生成以下方向的实现：
	1.	把 Scheduler 写成一个大聊天 Agent
	2.	把前端写成 conversation-first / project-first 产品
	3.	把 review / blocked 通知做成聊天消息主入口
	4.	在 service / adapter / repository 中偷偷改状态
	5.	跳过 verifier 直接把 worker done 当成完成
	6.	执行中允许直接改 demand objective
	7.	把 worker adapter 和业务 handler 强耦合
	8.	把所有逻辑堆在 index.ts 或单个 service 里

⸻

13. 输出物要求

第一轮代码生成后，优先保证这些输出物存在：

后端
	•	可运行的 TypeScript server 骨架
	•	JSON repositories
	•	event bus
	•	handlers 骨架
	•	minimal planner/dispatcher/verifier/reconciliation
	•	codex/opencode adapter stub 或最小实现
	•	REST API routes
	•	websocket broadcaster

前端
	•	保持冻结设计
	•	至少可展示 dashboard / demand detail / workers / settings 的最小骨架
	•	decision panel 必须存在

⸻

14. 推荐工作方式

建议你分两轮生成：

第 1 轮

先生成：
	•	domain
	•	repositories
	•	event bus
	•	handlers skeleton
	•	minimal api
	•	adapter interfaces

第 2 轮

再生成：
	•	planner / dispatcher / verifier / reconciliation 的具体逻辑
	•	codex / opencode adapter 细节
	•	websocket / ops monitor
	•	前端联调

⸻

15. 最终要求

生成代码时，优先保证：
	•	架构正确
	•	状态迁移正确
	•	协议正确
	•	可调试
	•	易扩展

而不是优先追求：
	•	花哨 UI
	•	复杂自治
	•	全自动魔法行为

Nodikt v1 的核心目标是：

先做一个可控、鲁棒、可验证的 Intent OS 骨架。