# Nodikt 项目定义文档

## 1. 项目背景与目标

### 1.1 项目背景与 Position

当前主流 Agent 系统已经证明：AI 可以执行多步任务、调用工具、操作代码与外部环境。但真实使用中仍普遍存在一种体验：**用户必须持续盯着运行过程，随时补 context、处理报错、担心任务静默失败**。这是一种典型的 **“盯盘式 AI 协作”**。

这类系统的问题不在于单次能力不够强，而在于：

- 结果往往依赖用户持续看护；
- 一旦中断、报错、超时，任务容易失去连续性；
- 用户必须替系统管理上下文、恢复现场、决定下一步；
- 人无法真正离开工位，认知负担和切换成本很高。

Nodikt 的路线区别在于：

> **不把系统价值建立在“单次跑得更猛”上，而建立在“无需 babysit，也能稳稳推进、持续反馈、长期变好”上。**

换句话说，Nodikt 不追求一次吃个大胖子，而追求：

- 每一轮都推进一点；
- 每一步都有状态；
- 成功会反馈；
- 失败会反馈；
- 卡住会反馈；
- 系统自己先兜底，兜不住再把人拉回来。

这条路线的根本判断是：

1. **单次任务表现会随着 base model 演进持续提升**，这不应成为系统层的核心护城河；
2. **系统层真正难、也真正有价值的，是把 AI 变成一个可以长期托付的执行系统**；
3. AI 的优势不只是“瞬间更强”，更是可以在时间维度上持续重复探索、不断积累、反复推进；
4. 因此，系统应优化的不是 one-shot peak performance，而是 **stable progress under unattended execution**。

Nodikt 的 position 因此非常明确：

> **Nodikt 是一个面向“稳态推进”的 Human Intent Operating System。它的核心不是提升单次样例表现，而是让 demand 在无人盯盘时也能持续推进、持续反馈、持续累积。**

---

### 1.2 项目目标

Nodikt 的目标，是把 AI 从“需要人看着跑的 agent”变成“可以被托付的执行系统”。

它不承诺每次都给出最优答案，但承诺以下几点：

- demand 一旦提交，系统会持续推进，而不是静默停住；
- 成功、失败、阻塞都会被明确记录并反馈给用户；
- 用户不需要自己维护上下文和恢复现场；
- 用户可以离开工位，把注意力放回更高价值的事情；
- 系统通过反复推进与反馈，在长期迭代中持续变强。

一句话说，Nodikt 的目标是：

> **把“盯盘式 AI 协作”改造成“可离手、可追踪、可恢复、可持续推进”的执行系统。**

对应的解决方案核心思想是：

- 用 **hardcode 的 Scheduler Runtime** 承担确定性控制；
- 用 **LLM Engines** 提供智能，但不掌握流程控制权；
- 用 **Ops** 做兜底、恢复、升级与通知；
- 用 **Stateful Session** 维护当前运行态；
- 用 **Persistent Event History** 记录完整事实账本；
- 用 **小步推进 + 验证 + 反馈 + 重规划** 代替一次性豪赌式执行。

---

## 2. 项目设计

### 2.1 设计原则

#### 原则 1：稳态推进优先于单次峰值
系统追求的是长期连续推进，而不是一次性最强输出。只要任务仍可推进，系统就应继续向前，而不是等待“完美一击”。

#### 原则 2：控制平面必须是代码，不是提示词
流程控制、状态转移、调度、重试、恢复、通知等核心逻辑必须由 hardcode 实现。这样才有确定性、traceback、可监控性和可恢复性。

#### 原则 3：LLM 只提供智能，不拥有控制权
LLM 用于澄清、规划建议、总结、验证辅助与路由建议；但真正的状态推进与动作触发由 Scheduler Runtime 决定。

#### 原则 4：运行态与历史账本分离
系统必须区分：
- **Session**：当前做到哪了；
- **Event History**：到底发生过什么。

Session 可压缩、可恢复；Event History 必须追加写入、可追溯、可重放。

#### 原则 5：先验证，再推进
Worker 的“我做完了”不等于系统认可完成。只有验证通过，系统状态才能前进。

#### 原则 6：系统必须永远有回应
无论成功、失败、阻塞、超时、API 异常还是运行停滞，系统至少都要给用户一个明确反馈。

#### 原则 7：最小设计，覆盖全部主需求
对象与接口只保留最小必需集合，但必须覆盖：提醒、研究、构建、外部操作、长时间任务、人工中断与恢复。

#### 原则 8：用户意志高于当前执行
用户可随时打断、修改、终止、插入约束。系统必须立即吸收该事件并重规划。

---

### 2.2 逻辑架构

```text
User
  <-> Interface
  <-> Brain
  <-> Workers / External Systems

Brain = Scheduler Runtime + LLM Engines + Ops + Session Store + Event Store
```

#### 1）Interface
Interface 是用户与系统的交互面，不负责智能决策，负责：

- 接收 demand；
- 展示当前状态、进度、阻塞与结果；
- 接收用户中断、修改、补充信息；
- 向用户推送关键通知；
- 提供 demand/session/event 的可见视图。

#### 2）Brain
Brain 是唯一控制中枢，由五个部分组成。

##### a. Scheduler Runtime
Scheduler Runtime 是系统的硬编码控制平面，负责：

- 接收 demand 并建立 session；
- 管理当前 phase、frontier、等待项、已完成项；
- 组织长期 memory 与当前 task context；
- 决定何时调用 LLM、何时派发 worker、何时验证、何时重试；
- 写入事件；
- 根据事件驱动状态转移；
- 在用户 interrupt 后立即重规划。

它的本质是：

> **一个事件驱动的异步状态机。**

##### b. LLM Engines
LLM Engines 是智能能力层，不直接控制系统，只响应 Scheduler 的调用。主要负责：

- demand 澄清；
- 子目标建议；
- context 压缩与总结；
- 路由建议；
- 验证辅助；
- 用户可读说明生成。

##### c. Ops
Ops 是系统兜底层，负责：

- 监控 scheduler、worker、API、外部工具链是否异常；
- 识别“报错”与“停滞”两类问题；
- 自动重试、切换备用路径、触发 fallback；
- 无法恢复时通知用户说明问题。

Ops 的目标不是“更聪明”，而是：

> **保证系统不会默默失效。**

##### d. Session Store
保存当前 demand 的运行态：当前做到哪、在等谁、最近进展是什么、从哪里恢复。

##### e. Event Store
以追加写方式保存完整事件历史：谁在什么时间做了什么，返回了什么，系统如何处理。

#### 3）Workers
Workers 是执行面，只围绕当前 subgoal 工作，不拥有全局控制权。职责包括：

- 接收结构化 subgoal；
- 在预算和约束内执行；
- 产出 artifact；
- 返回 DONE / BLOCKED / FAILED / PARTIAL 等结构化结果。

#### 4）External Systems
包括代码仓库、文件系统、浏览器、第三方 API、调度系统、通知系统等。它们是执行目标环境，不承担控制逻辑。

---

### 2.3 核心工作流

Nodikt 的工作流坚持同一个闭环：

```text
Demand -> Clarify -> Session -> Plan Frontier -> Dispatch -> Execute
       -> Verify -> Reconcile -> Replan -> Notify
```

#### Step 1：提交 Demand
用户提交一个 demand。它可以是：

- 立即提醒类；
- 定时/周期任务类；
- 信息研究类；
- 构建产物类；
- 外部操作类；
- 混合型长任务。

系统先写入 `DemandSubmitted` 事件，并创建 Session。

#### Step 2：澄清并编译为 Operational Objective
如果 demand 已足够明确，直接进入执行；如果不够明确，Scheduler 调用 LLM 做最小必要澄清。最终得到统一的 Operational Objective。

这里的原则是：

- 能直接执行就不要过度澄清；
- 真会影响执行成败的点必须问清；
- 不把所有上下文管理责任推回给用户。

#### Step 3：建立 / 恢复 Session
Scheduler 读取或初始化当前 Session，包括：

- 当前 phase；
- 当前 frontier；
- 最近摘要；
- 等待项；
- 最近 checkpoint。

同时从 Event Store 读取必要历史，用于恢复现场与构建上下文。

#### Step 4：生成当前 Frontier
Scheduler 不一次性展开全部未来任务，只生成**当前这几步最值得做的 frontier**。

- 简单 demand：可直接编译为一个 action 或 schedule；
- 复杂 demand：拆成一组可执行 subgoals；
- 长任务：每轮只下发当前阶段的 subgoals。

#### Step 5：派发给 Worker
Scheduler 基于 worker 能力、状态、权限、预算选择合适 worker，并下发 `SubgoalContract`。

#### Step 6：Worker 执行并回报
Worker 在限定边界内执行，返回结构化 `WorkerResult`。无论结果如何，都必须回报，而不是静默结束。

#### Step 7：验证
Scheduler 对产物和结果进行验证：

- artifact 是否存在；
- success criteria 是否满足；
- claimed outcome 是否与事实一致；
- 是否需要人工确认。

#### Step 8：Reconcile
系统根据验证结果更新 Session，并追加事件：

- 完成则推进；
- 部分完成则保留成果并继续；
- 阻塞则进入 waiting 状态；
- 失败则决定重试、换路、升级或终止。

#### Step 9：Replan
Scheduler 根据最新 Session + Event History 生成下一轮 frontier。系统默认继续推进，除非：

- 已满足完成条件；
- 明确无法继续；
- 等待用户输入；
- 用户主动中断。

#### Step 10：Notify
关键节点必须通知用户：

- 任务开始；
- 阶段完成；
- 需要用户输入；
- 已切换兜底路径；
- 执行失败；
- 全部完成。

#### Interrupt 融入流程
Interrupt 不是额外分支，而是主流程中的高优先级事件。用户一旦发出 interrupt，Scheduler 立刻：

1. 写事件；
2. 更新 Session；
3. 取消或暂停受影响执行；
4. 重建 frontier；
5. 重新决定是否继续。

---

### 2.4 核心 Schema

只保留最小但够用的 7 个核心 schema。

#### 1）Demand
用于描述用户真正要达成的事情。

```text
Demand = {
  demand_id,
  type,
  goal,
  inputs,
  constraints,
  success_criteria,
  trigger,
  autonomy,
  notify_policy,
  workspace,
  priority,
  status
}
```

字段说明：

- `demand_id`：需求唯一标识。
- `type`：需求类型。建议最小枚举：`notify | research | build | operate | mixed`。
- `goal`：最终要完成什么。
- `inputs`：已知输入材料，如仓库、文档、参数、上下文。
- `constraints`：不能做什么，或必须遵守什么。
- `success_criteria`：什么条件下算完成。
- `trigger`：何时执行。支持立即、定时、周期、事件触发。
- `autonomy`：允许系统自主到什么程度。
- `notify_policy`：何时、以什么方式反馈用户。
- `workspace`：执行所依赖的工作空间或目标环境。
- `priority`：调度优先级。
- `status`：当前需求状态。

#### 2）Session
用于表示当前运行态。它回答的是：**现在做到哪了。**

```text
Session = {
  session_id,
  demand_id,
  phase,
  current_summary,
  frontier,
  waiting_on,
  latest_checkpoint,
  last_progress_at,
  status
}
```

字段说明：

- `session_id`：运行会话 ID。
- `demand_id`：关联的 demand。
- `phase`：当前阶段，如 clarify / execute / verify / wait / done。
- `current_summary`：当前高层摘要，用于恢复执行。
- `frontier`：当前待推进的 subgoals。
- `waiting_on`：当前在等什么，例如用户输入、外部资源、worker 返回。
- `latest_checkpoint`：最近可恢复点。
- `last_progress_at`：最近一次有进展的时间。
- `status`：当前运行状态。

#### 3）Event
用于表示完整事实历史。它回答的是：**到底发生过什么。**

```text
Event = {
  event_id,
  session_id,
  demand_id,
  event_type,
  source,
  timestamp,
  payload,
  outcome,
  visibility
}
```

字段说明：

- `event_id`：事件唯一标识。
- `session_id`：所属 session。
- `demand_id`：所属 demand。
- `event_type`：事件类型，如 submit / clarify / dispatch / result / verify / notify / interrupt。
- `source`：事件来源，如 user / scheduler / worker / ops / system。
- `timestamp`：发生时间。
- `payload`：结构化事件内容。
- `outcome`：该事件被如何处理，如 accepted / rejected / processed / failed。
- `visibility`：可见性，如 internal / user_visible / audit_only。

#### 4）SubgoalContract
用于下发给 worker 的最小执行合同。

```text
SubgoalContract = {
  subgoal_id,
  objective,
  context_ref,
  success_criteria,
  failure_criteria,
  constraints,
  budget,
  deliverables,
  dependencies,
  assigned_worker
}
```

字段说明：

- `subgoal_id`：子目标 ID。
- `objective`：当前要达成的具体目标。
- `context_ref`：当前 subgoal 所需上下文引用，不直接塞全部历史。
- `success_criteria`：成功判据。
- `failure_criteria`：什么情况应判失败或停止。
- `constraints`：边界约束。
- `budget`：资源上限，如时间、步数、token、成本。
- `deliverables`：必须交回的产物。
- `dependencies`：前置依赖。
- `assigned_worker`：被分配的 worker。

#### 5）WorkerResult
用于 worker 对 Scheduler 的标准回报。

```text
WorkerResult = {
  subgoal_id,
  worker_status,
  claimed_outcome,
  produced_artifacts,
  compressed_history,
  blocker_reason,
  suggested_next_step
}
```

字段说明：

- `subgoal_id`：对应哪个 subgoal。
- `worker_status`：最小枚举：`DONE | BLOCKED | FAILED | PARTIAL`。
- `claimed_outcome`：worker 认为自己完成了什么。
- `produced_artifacts`：交回的文件、PR、结果对象等。
- `compressed_history`：本轮执行的压缩轨迹。
- `blocker_reason`：阻塞原因。
- `suggested_next_step`：worker 建议的下一步。

#### 6）VerificationResult
用于验证层的判定结果。

```text
VerificationResult = {
  subgoal_id,
  verified_status,
  accepted_artifacts,
  gap,
  notes
}
```

字段说明：

- `subgoal_id`：对应 subgoal。
- `verified_status`：最小枚举：`VERIFIED_DONE | PARTIAL | FAILED | UNVERIFIABLE`。
- `accepted_artifacts`：被系统正式接受的产物。
- `gap`：未满足的缺口。
- `notes`：验证说明。

#### 7）WorkerProfile（运行注册表）
用于调度时判断 worker 是否可用。

```text
WorkerProfile = {
  worker_id,
  capabilities,
  tools,
  concurrency,
  status,
  workspace_access
}
```

字段说明：

- `worker_id`：worker 唯一标识。
- `capabilities`：擅长类型，如 code / browser / research / ops。
- `tools`：可用工具清单。
- `concurrency`：最大并发数。
- `status`：idle / busy / offline / error。
- `workspace_access`：可访问的环境范围。

---

### 2.5 核心 Interface

只保留最小必需的 6 个接口面。

#### 1）SubmitDemand
用户向系统提交新需求。

```text
SubmitDemand(input: DemandDraft) -> { demand_id, session_id }
```

意义：系统的入口。任何提醒、研究、构建或操作都先被统一接成一个 demand。

#### 2）InterruptSession
用户在运行过程中发出中断、修改、补充或终止。

```text
InterruptSession(
  session_id,
  action,          # pause | resume | modify | stop | reprioritize
  message,
  patch
) -> { accepted }
```

意义：保证用户始终拥有最高控制权。

#### 3）CallEngine
Scheduler 调用 LLM Engines 获取智能帮助。

```text
CallEngine(
  task,            # clarify | plan | summarize | route_hint | verify_hint
  input,
  constraints,
  output_schema
) -> structured_output
```

意义：把 LLM 明确限定为“被调用的能力层”，而不是控制器。

#### 4）DispatchSubgoal
Scheduler 向 worker 下发任务。

```text
DispatchSubgoal(input: SubgoalContract) -> { accepted, worker_id }
```

意义：把执行单元的输入固定成统一合同，降低系统耦合。

#### 5）ReportResult
Worker 回传执行结果。

```text
ReportResult(input: WorkerResult) -> { accepted }
```

意义：确保 worker 无论成功、失败还是阻塞，都走统一上报路径。

#### 6）NotifyUser
系统向用户发出通知。

```text
NotifyUser(
  demand_id,
  level,           # info | action_required | warning | failure | success
  title,
  message,
  action_hint
) -> { delivered }
```

意义：把“系统必须有回应”变成一等接口，而不是附加功能。

---

## 3. 相关工作

- **Anthropic Claude Managed Agents**：强调 `stateful sessions` 与 `persistent event history`，说明长任务需要有状态运行与事件账本。
- **Anthropic Effective Harnesses for Long-Running Agents**：强调跨 session 的增量推进与清晰交接，反对 one-shot 式长任务执行。
- **Multica**：明确提出 “no more babysitting runs”，并把 managed agents、board、skills 复用作为核心体验。
- **OpenHands**：强调透明、可控、可扩展的 coding agents，覆盖 CLI、GUI、Cloud、SDK。
- **LangGraph**：提供 interrupt + persistence，适合 human-in-the-loop 与可恢复执行。
- **Temporal**：提供 durable execution 与 event history 的工程范式，证明长流程系统应建立在可恢复执行和事件重放之上。
- **ReAct**：提出 reasoning + acting 的交替范式，是工具使用型 agent 的经典起点。
- **Voyager**：强调长期探索、技能积累与持续提升，说明 AI 系统的价值可以建立在反复推进和能力复利上。
