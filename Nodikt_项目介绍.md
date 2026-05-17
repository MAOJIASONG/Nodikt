# Nodikt

> Human Intent Operating System — 让 AI 从需要看着跑，变成可以托付的执行系统。

---

## 引言

过去两年，AI agent 在单次任务上的表现已经被证明了：它能写代码、能查资料、能调工具、能完成一连串动作。但凡是真用过的人都有同一种感受——

> _"它能跑，但我没法离开。"_

你必须盯着它，时不时补一句 context；它一报错你就得救火；它静默卡在某一步你也只能不停刷新；任务一旦中断，上下文就丢了，得从头讲一遍。这是当前所有主流 agent 系统共有的体验，可以称为 **"盯盘式 AI 协作"**。

Nodikt 不打算把单次跑得更猛 —— 这件事会随着 base model 自然变好。我们押的是另一条赛道：**让 AI 任务可以被托付。** 你提交一个 demand 之后真正能离开工位，回来时要么任务已经推进了一步、要么明确告诉你卡在哪、为什么、下一步建议怎么做。

本文档介绍 Nodikt 的设计哲学、技术架构、关键能力与当前进度。

---

## 1. 是什么

Nodikt 是一个面向"稳态推进"的 Human Intent Operating System。它接收用户的 demand（不限定形态——可以是研究、构建、运维、提醒、定时任务、混合长任务），然后用一套**确定性的工程化调度系统**驱动一组 AI worker 持续推进，直到完成或在明确节点向用户回报。

它不试图替代任何具体的 AI 工具。Cursor、Claude Code、OpenHands、aider 这些工具都是它的**worker**；ChatGPT / Claude / 本地模型这些 LLM 都是它的**engine**。Nodikt 是它们之上那一层缺失的 **OS**：负责调度、状态管理、事件账本、验证、兜底、人机交互、长期 memory。

**类比一下**：

- 一颗 CPU 很强，但你不会直接拿它写应用 —— 中间需要操作系统。
- 一个 LLM 很强，但你不会直接拿它处理长任务 —— 中间也需要 OS。

Nodikt 是那一层 OS。

---

## 2. 我们解决什么问题

### 2.1 用户侧的痛点

| 现象 | 真实场景 |
|---|---|
| **盯盘焦虑** | "我让 Cursor 重构这个模块，但我得一直在屏幕前，否则它走偏了我都不知道" |
| **上下文管理负担** | "Claude Code 一开新会话上下文就没了，我又得从头讲一遍我的代码结构" |
| **静默失败** | "我昨晚提了一个 demand，今早回来看它什么都没发生，也没告诉我为什么" |
| **不可恢复** | "运行一半中断了，没办法接着继续，只能整个重来" |
| **没有反馈机制** | "我不知道它现在在做什么、卡在哪里、需不需要我介入" |

这些问题**不是模型不够聪明造成的**。base model 变强一倍它们依然存在。它们是**系统层**的问题。

### 2.2 我们押的三个判断

1. **单次任务表现会随着 base model 演进持续提升**——这不应成为系统层的护城河。
2. **真正难、也真正有价值的，是把 AI 变成一个可以长期托付的执行系统**——长跑、可恢复、有事件账本、能反馈。
3. **当 AI 从工具变成基础设施时，必然需要这一层 OS**——就像计算机进入家庭必然要先有 Windows / macOS。

倒推过来，Nodikt 优化的核心指标不是 one-shot peak performance，而是 **stable progress under unattended execution**。

---

## 3. 设计哲学

Nodikt 的 8 条设计原则（详见 `Nodikt_项目定义文档_稳态推进版.md` §2.1）：

1. **稳态推进优先于单次峰值** — 只要任务还能推进就持续推进，不等"完美一击"。
2. **控制平面必须是代码，不是提示词** — 流程控制、状态机、调度逻辑全部硬编码，可观测、可监控、可恢复。
3. **LLM 只提供智能，不拥有控制权** — 模型用于澄清、规划、总结、验证辅助，**不直接驱动状态转移**。
4. **运行态与历史账本分离** — Session 表示"做到哪了"，Event 表示"发生了什么"；两者分开存储、分开演化。
5. **先验证，再推进** — Worker 说"我做完了"不算数，系统要验证（artifact 存在性 + LLM 检查 + 必要时人工确认）才能推进状态。
6. **系统必须永远有回应** — 无论成功、失败、阻塞、超时、API 异常，都要给用户一个明确反馈。
7. **最小设计，覆盖全部主需求** — Schema 和 interface 保留最小集合，但要能覆盖提醒、研究、构建、运维、长任务、人工中断与恢复。
8. **用户意志高于当前执行** — 用户可随时打断、修改、补充。系统立即吸收并重规划。

这 8 条原则贯穿了整个实现。如果哪一行代码违反了它们中的任何一条，那是 bug，不是 feature。

---

## 4. 架构

### 4.1 用户感知视角

从用户角度看，Nodikt 只有三件事：

```text
                    Nodikt
                      │
   ┌──────────────────┼──────────────────┐
   │                  │                  │
 提交 demand     看系统在做什么       在关键节点回应
 (随时可以)      (随时可以看)         (有需要时弹窗)
   │                  │                  │
   └──────────────────┴──────────────────┘
                      │
                  长跑 / 推进 / 反馈
                  (你可以离开工位)
```

它**不需要你**：
- 维护上下文
- 监控运行状态
- 处理报错
- 决定下一步该派什么 worker
- 记住上一轮的 lessons

它**需要你**：
- 提供清晰的 demand（不清晰时它会问你）
- 在它真拿不准的时候做决定（plan 审核、模糊场景、冲突取舍）

### 4.2 技术架构视角

```text
User
  ↕  Interface           ← Web UI (React + Vite) + HTTP / WebSocket
  ↕  Brain
  │   ├─ Scheduler Runtime    硬编码控制平面，事件驱动状态机
  │   ├─ LLM Engines          智能能力层（澄清 / 规划 / 验证 / 决策辅助）
  │   ├─ Ops Monitor          兜底层（heartbeat / timeout / 恢复 / 升级）
  │   ├─ Session Store        当前运行态（做到哪了）
  │   ├─ Event Store          完整事件账本（发生了什么）
  │   └─ Memory Manager       三层记忆（mission state / episodic trace / lessons）
  ↕  Workers               AI 执行体（claude_code / opencode / codex / 任意 stream-json 第三方）
  ↕  External Systems     代码仓库 / 文件系统 / 浏览器 / API / 通知系统
```

四个角色的关系：

- **Interface** 只翻译 I/O 到事件，不持有业务逻辑。
- **Brain** 是唯一的控制中枢，五个内部模块各司其职。
- **Workers** 只围绕当前 subgoal 工作，不知道全局，不持有控制权。
- **External Systems** 是执行目标环境，被 worker 通过工具触达。

详细的模块边界规则见 `doc/06_backend_module_boundaries.md`。

### 4.3 控制平面是代码，不是提示词

这是 Nodikt 与多数 prompt-driven agent 框架最根本的区别。

| 流程要素 | Nodikt 实现 |
|---|---|
| 状态推进 | TypeScript 状态机 + zod 校验，每一次转移都明确 |
| 调度 | EventBus 持久化 + recursive publish，可重放 |
| 重试与恢复 | OpsMonitor 主动探测 + recovery policy 决定策略 |
| 人机交互 | DECISION_REQUEST 事件 + 结构化 metadata，前端按 reason_code 渲染 |
| 长期记忆 | 写时持久化、读时按需注入，永远不丢 |

LLM 在这套架构里只**被调用**，而不**调用别人**。它的所有输入是结构化 prompt，输出是结构化 JSON；任何模糊不清的输出都被 verifier 或 decision service 截断成"需要用户介入"。

---

## 5. 关键能力

### 5.1 事件溯源调度

每一次状态推进都对应一条事件，所有事件按时间持久化。这意味着：

- 任何 demand 的执行历史都可以**像数据库 binlog 一样重放**
- 系统出 bug 不靠"模型今天不在状态"赖账，看事件链就能 traceback
- 任何模块的副作用都可被外部脚本订阅、监控、衍生

实现位置：`server/src/brain/scheduler/event_bus/eventBus.ts` 加 `handlers/`。

### 5.2 三层 Memory + 渐进式反馈闭环

每一轮 worker 完成（无论成功还是失败）后，verifier 会写三条 memory：

- **`mission_state`**：当前任务整体在哪一步
- **`episodic_trace`**：本轮 worker 的关键动作轨迹
- **`lessons_or_policy`**：本轮失败 / 阻塞中提炼的教训

下一轮 dispatch 时，dispatcher 从 memory 库取最近 N 条，写到新 `WorkerDispatchPacket` 的 `shared_hints` / `relevant_history` / `mission_state_summary` 字段。**worker 拿到 packet 时，能在 prompt 里直接读到"上一次因为什么失败 / 应该避开什么"**。

这是 "stable progress" 的物理实现。没有这个机制，每一次 retry 都只是把同样的事再做一遍指望命好。

### 5.3 显式 / 隐式两种 Replan

| 类型 | 触发时机 | UI 体验 | 设计意图 |
|---|---|---|---|
| **显式 Plan Review** | 首次出方案 / 用户主动点 Replan / 用户在决策面板提反馈 | 弹决策卡 "Plan Review"，三选一：Approve / 提反馈 / Reject | 凡是涉及**方向变更**，让人拍板 |
| **隐式 Auto Replan** | worker 报 PARTIAL / verifier 判 PARTIAL | 不打扰用户，plan 版本号 +1，继续推进 | 战术性调整，不浪费用户注意力 |

显式 plan-review 让用户保留所有权；隐式 replan 让系统不被琐碎挡路。两者通过 `event.payload.reason` 字段在 `onPlanGenerated` 中分流，逻辑明确。

### 5.4 接入任意第三方 Agent 工具

Worker adapter 接口最小化，已实现 3 个：

- **opencode**：通用 CLI worker
- **codex**：轻量占位 worker
- **claude_code**：完整 stream-json 协议解析。会捕获 session id、解析每个 tool_use、识别 AskUserQuestion / NEED_CLARIFICATION 等"模型想问用户"的信号、自动 `--resume <sid>` 续接对话

**接新 worker 的范式**：继承 `BaseLocalCommandAdapter`，覆盖 `resolveCommand` 和 `onStdoutLine` 两个钩子即可。从开始到接通约 1 周。理论上任意有 CLI / API 接口的 AI 工具都能接入。

### 5.5 完整的人机决策通道

五类"系统拿不准"的场景，都会弹出**结构化的决策面板**：

1. **PLAN_REVIEW**：新方案出来了，请审核
2. **UNVERIFIABLE_RESULT**：worker 报完成但 verifier 判不准，请你看一眼
3. **BLOCKED**：worker 自己说卡住了，缺信息 / 缺权限 / 工具失败
4. **MISSING_PERMISSION / INSTALL_REQUIRES_REVIEW**：要做权限敏感的事，先问你
5. **OPS_ALERT**：系统兜底层探测到异常无法自动恢复

每一类决策都有**明确的 reason_code + 结构化选项 + 友好的 prompt**。用户点 Approve / Reply / Reject / Cancel，系统按规则继续推进。

### 5.6 状态可观测

Web UI 实时显示：

- 当前 demand 的所有 subgoal 卡片（带状态色标 + planning round badge）
- 完整事件流（按时间线，含每次 worker heartbeat / verifier 判定 / 决策响应）
- 决策面板（蓝色的 Plan Review 与黄色的 Issue Decision 视觉区分明确）
- Settings 面板（4 个模型角色、运行时参数、worker 策略全可配）

---

## 6. 工作流

Nodikt 的核心工作流是同一个 10 步闭环（详见 `Nodikt_项目定义文档_稳态推进版.md` §2.3）：

```text
Demand → Clarify → Session → Plan Frontier → Dispatch → Execute
                                                              │
                                                              ▼
              ┌── Notify ◀── Replan ◀── Reconcile ◀── Verify
              │
              └── (向用户回报 / 等待下一轮)
```

具体来说：

1. **提交 Demand**：用户写一句话或一段描述，系统创建 demand 并立即建立 session。
2. **澄清并编译为 Operational Objective**：模糊就问，清晰就走。澄清是最小必要的（不会问"你的工作目录是什么"这种 5 个问题挤一起的傻问题）。
3. **建立 / 恢复 Session**：从 event store 读历史、初始化 session checkpoint。
4. **生成 Frontier**：不一次性展开未来全部任务，只生成**当前最值得做的几步**。这是 progressive planning 的体现。
5. **派发给 Worker**：基于能力 / 状态 / 权限 / 预算 / 历史经验，选合适的 worker，下发 `SubgoalContract`。
6. **Worker 执行**：在 budget 内做事，结构化回报 `WorkerResult`（DONE / PARTIAL / FAILED / BLOCKED / NEED_HELP）。
7. **验证**：artifact 物理存在性检查 + LLM 验证 success criteria + 必要时人工确认。
8. **归并（Reconcile）**：根据验证结果更新 session + 写 memory + 决定继续 / 重试 / 升级 / 终止。
9. **重规划（Replan）**：根据最新状态生成下一轮 frontier。**隐式自动 replan + 显式人工 replan** 两条路径自然衔接。
10. **通知（Notify）**：关键节点向用户回报。任务开始 / 阶段完成 / 需要输入 / 已切换兜底 / 失败 / 完成。

**Interrupt 不是分支，是主流程中的高优先级事件**。用户随时打断、修改、补充，系统立即吸收并重建 frontier。

---

## 7. 适用场景

Nodikt 的 sweet spot 是 **"清晰但长跑"** 的任务。具体类别：

### 7.1 研发型

- 仓库重构 + 测试覆盖率提升
- 跨服务的安全审计
- 把一个 prototype 包装成生产级模块
- 实现一份 spec 中的所有 API 端点
- 跨多轮迭代的代码 review 闭环

### 7.2 知识型

- 持续监控某个领域的更新 + 周报汇总
- 把多源材料结构化成研究 brief
- 长期跟踪某个项目 / 团队 / 仓库的演化
- 自动整理会议纪要 / 周记并按主题归档

### 7.3 运维型

- 定期巡检某组服务的健康度并触发处置
- 跟踪 incident 全周期（从告警到 postmortem）
- 自动化升级管理 / 版本演进 / migration 推进

### 7.4 生活 / 个人型

- 周期性安排（生日 / 节日 / 健康检查提醒 + 实际下单）
- 长期个人项目管理（写一本书 / 学一门语言 / 找一份工作）

**不适合的场景**：

- 一次性的小任务（"帮我改一行代码" / "查一下这个 API 的文档"）—— 直接用 Cursor / Claude Code / ChatGPT 更快
- 需要严格实时的任务（< 1 秒响应）—— Nodikt 的事件链有持久化代价
- 高度结构化的 ETL / 数据处理流水线 —— Airflow / Temporal 更合适

---

## 8. 与同类工作的关系

Nodikt 不是凭空造的。我们站在几个已经被验证过的工程范式上，并把它们重新组合：

| 参考 | 我们继承了什么 |
|---|---|
| **Anthropic Managed Agents** | stateful sessions + persistent event history 的范式 |
| **Anthropic Effective Harnesses for Long-Running Agents** | 跨 session 的增量推进 + 清晰交接 |
| **LangGraph** | interrupt + persistence + human-in-the-loop 的实现路径 |
| **Temporal** | durable execution + event replay 的工程证明 |
| **Multica** | "no more babysitting runs" 的产品体验主张 |
| **OpenHands** | 透明可控的 coding agent 的开源工程参考 |
| **ReAct / Voyager** | reasoning + acting + 长期能力积累的概念基础 |

**与每一类的差异**：

- 相比单个 agent 工具（Cursor / Claude Code / aider）—— **我们不替代它们，我们把它们接成 worker**
- 相比 LangGraph / Temporal —— **我们针对 AI 任务做了 verifier、memory、人机决策**这套上层逻辑，而不只是 generic workflow
- 相比 Managed Agents / Multica —— **我们坚持开源 + 用户拥有所有事件 / memory / worker 选型**

---

## 9. 当前实现状态

代码仓库结构：

```text
framework-nodkit_v0.3.1/
├── server/                 后端（TypeScript + Express + ws + pino）
│   ├── src/brain/          Scheduler / LLM Engines / Memory / Verifier / Ops / Dispatcher
│   ├── src/worker/         Worker adapters
│   ├── src/interface/      HTTP routes + WebSocket broadcaster
│   ├── src/domain/         核心类型 / 枚举 / zod 校验
│   ├── data/               JSON 持久化（事件账本 / session / demand / ...）
│   └── logs/               pino 日志
├── web/                    前端（React 18 + Vite）
├── doc/                    架构与协议设计规范（编号 .md）
├── docs/pitch/             pitch 材料（内部对齐 + 外部 brief）
└── Nodikt_项目定义文档_稳态推进版.md  vision / 架构 schema
```

**已经端到端跑通的核心能力**（可以本地一键启动观察）：

- ✅ 事件总线 + 25 个 handler 全注册
- ✅ Session 单调更新 + 事件账本持久化
- ✅ Planner 澄清 + 渐进式 frontier 生成
- ✅ Verifier LLM 验证 + artifact 物理存在性 fallback
- ✅ Reconciliation 状态推进规则
- ✅ Memory 三层写 + 注入到下一轮 dispatch
- ✅ Worker adapter：opencode / codex / claude_code 三类
- ✅ Claude Code 完整 stream-json 集成（session 续接 + AskUser 识别）
- ✅ 显式 Plan Review + 隐式 Auto Replan 两形态
- ✅ 五类决策面板（PLAN_REVIEW / UNVERIFIABLE / BLOCKED / 权限类 / OPS_ALERT）
- ✅ 实时 WebSocket 事件流推送
- ✅ 多模型角色独立配置

**已经在真实 demand 上跑过**（仓库内 `server/data/` 可查）：

- _"用 HTML5 Canvas 写一个坦克大战"_ → claude_code 一轮写出 8 个文件，verifier 通过，产物可直接玩
- _"给我妈妈生日推荐一些盆栽"_ → opencode 写 9KB markdown，verifier 通过

**还在打磨**：

- 工具调用可视化（adapter_meta 里数据已经全有，前端展示待完善）
- 多 worker 并行编排
- 后台运行 + 通知通道（邮件 / 飞书 / TG）
- 跨 demand memory 联邦
- 多人协作

详细的 backlog 与里程碑见 `docs/pitch/internal.md` §6-7。

---

## 10. 本地跑起来

需要 Node 20，仓库根有 `.nvmrc`。

```bash
# 1. clone 仓库后
cp .env.example .env
# 编辑 .env 填入你的 LLM API key（dashscope / openai / anthropic 任意之一）

# 2. 安装依赖
npm install

# 3. 开发模式（3 个终端）
./dev-tsc.sh    # T1: server 增量编译
./dev-server.sh # T2: node 后端 (:3001)
./dev-web.sh    # T3: vite 前端 (:5173)

# 浏览器打开 http://localhost:5173
```

第一次进去会让你选 / 配置 worker。默认会自动注册 `worker_opencode_local` 和 `worker_claude_code_local`。

---

## 11. 进一步阅读

- **`Nodikt_项目定义文档_稳态推进版.md`** — Vision、设计原则、Schema、Interface 的权威定义
- **`doc/01-09_*.md`** — 各模块的详细设计规范（事件 / 状态机 / Worker 协议 / 前端 spec / ...）
- **`CLAUDE.md`** — 仓库总体说明（给 Claude Code 用，也给人读）
- **`docs/pitch/internal.md`** — 内部对齐文档（现状 + 路线 + 风险）
- **`docs/pitch/external.md`** — 对外 executive brief

---

## 12. 联系

<<TODO: 邮箱 / GitHub / 微信 / 其他联系方式>>

---

> _Nodikt 是一种判断：未来的 AI 不会停在"工具"层，它会变成基础设施。基础设施需要一层 OS。我们造它。_
