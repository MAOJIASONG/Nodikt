# Nodikt 内部对齐文档

> 给：内部协作小伙伴
> 目的：把项目"已经做到哪了 / 接下来要做什么 / 每个人能怎么上手"讲清楚，作为后续游说大佬的事实基础
> 配套阅读：`Nodikt_项目定义文档_稳态推进版.md`（首版 vision / 架构）、`docs/pitch/external.md`（对外 brief）
> 作者：<<TODO: 你的名字>>　最后更新：2026-05-16

---

## 0. TL;DR

Nodikt 押的是一条很反直觉的赛道：**不是把 agent 跑得更猛，而是把 agent 变成可以离手托付的执行系统**。

我们已经把这条路线的核心骨架在代码里立住了：

- 一套**事件驱动调度器**（hardcode 控制平面 + LLM 仅做智能咨询）已经能端到端把 demand 跑成 plan → dispatch → verify → replan
- 真正接入了**Claude Code**作为 worker，用 stream-json 协议解析它的工具调用、问答信号、session 续接，前端可见可干预
- 加入了**渐进式反馈闭环**（每一轮 retry / replan 都把上一次的 lessons 注入下一次 worker），这是"不会越跑越离谱"的关键
- 显式 plan-review（用户审核）+ 隐式 replan（worker 自己 PARTIAL 触发）两条 replan 形态都已闭合
- 整体在 Node 20 / TypeScript / React 上，单仓 monorepo，本地可一键启动（3 个终端）

下一步**最大瓶颈**是真实使用面的打磨：长任务的 cost / latency / verifier 准确率、UI 交付质感、典型 use case 的端到端 demo。这些事我们要在接下来的 4-12 周里集中砸。

ask 见 §8。

---

## 1. 我们押的是什么

`Nodikt_项目定义文档_稳态推进版.md` 已经把 position 写清楚了，这里挑出对外讲也通的三句关键判断：

1. **单次任务表现会随 base model 自然变强**——这不是系统层的护城河。一年后 GPT-X / Claude-Y 自己就能做得更准、更稳。我们押在这块没意义。
2. **真正难、真正反复出现的痛点是"盯盘焦虑"**——用户必须随时回来补 context、处理报错、决定下一步。所有当代 agent 系统在这点上都还差。
3. **系统层值得做的事是把 AI 变成"可托付"**——demand 提交后我离开工位，回来时要么任务推进了一步，要么明确告诉我卡在哪、为什么、怎么办。

把这三句倒过来推，**我们要造的是一个 Human Intent OS**，而不是又一个 agent。OS 的特征是：有状态、可恢复、有事件账本、有兜底、有通知。

如果未来 3 年 AI 系统真的从"工具"演化成"基础设施"，**那一定要有人把这一层做出来**。我们押这一层。

---

## 2. 架构鸟瞰

完整描述见 `Nodikt_项目定义文档_稳态推进版.md` §2.2。这里只标"代码现状"。

```text
User
  ↕  Interface         ← web 已经搭好（React 18 + Vite）；提交 demand / 审核 plan / 决策回复 全在 UI 里
  ↕  Brain
  │   ├─ Scheduler Runtime         ✅ event-sourced, 25 handlers 全注册
  │   │   ├─ EventBus              ✅ events.json 持久化 + WS 广播
  │   │   ├─ Session Reducer       ✅ sessions.json 单调更新
  │   │   ├─ Handlers              ✅ demand / planning / execution / review / ops
  │   │   └─ State Machine         ✅ Demand / Subgoal / Execution 三层枚举驱动
  │   ├─ LLM Engines               ✅ openai-compatible + anthropic 双协议
  │   │   ├─ Planner               ✅ 澄清 + frontier plan 生成
  │   │   ├─ Verifier              ✅ LLM 验证 + artifact 存在性检查降级
  │   │   └─ Decision Service      ✅ 人机决策对话
  │   ├─ Memory Manager            ✅ 三层 memory（mission/episodic/lessons），写+读全闭环
  │   ├─ Reconciliation            ✅ verified_status → 状态推进规则
  │   └─ Ops Monitor               ✅ heartbeat / timeout / 恢复策略
  ↕  Workers
      ├─ opencode adapter          ✅ 现役主力
      ├─ codex adapter             ✅ 轻量占位
      └─ claude_code adapter       ✅ stream-json 解析 + AskUser 识别 + --resume 续接
```

数据/事件账本都落地为 JSON 文件，仓库内可见：`server/data/{demands,subgoals,executions,workers,decisions,events,memory,sessions,settings}.json`。

**这里两件值得给大佬强调的事**：
1. 调度控制是**代码**，不是 prompt——任何复盘都能精确回放，任何 bug 都能 traceback。这是 LangGraph / Temporal 那套工程范式落到 agent 领域。
2. 三层 memory 不是装饰——它是渐进反馈闭环的物理实现。每一次 retry / replan 的新 packet 都带着上一轮 worker 的 lessons 进去（见 §3.3）。

---

## 3. 三个关键能力，已经在代码里跑通

### 3.1 事件溯源调度器

文件：`server/src/brain/scheduler/event_bus/eventBus.ts` 加 `handlers/`。

- 25 个 EventType，每个都有显式 handler 注册（见 `handlers/index.ts`）
- HTTP 路由不直接改状态，只 publish 事件 → handler 负责状态推进 → handler 返回的 follow-up 事件递归 publish
- 所有事件持久化到 `events.json`，可重放
- 通过 `WsBroadcaster` 实时推到前端，前端订阅 `/ws`

**意义**：scheduler 的每一个动作都有事件留底，每一次 demand 的生命周期都能在事件序列里完整追溯。出问题不靠"模型今天没睡好"赖账，而是看事件链。

### 3.2 Claude Code 流式集成

文件：`server/src/worker/adapters/claudeCodeAdapter.ts`。

claude_code 这种"内部还自己跑 agent loop"的 worker 是这一代 AI 工具的代表（Cursor、Cline、Aider 是同形态）。我们要能接它们，且接进来之后让它们看起来跟"普通 worker"一样。

我们做到了：
- `claude -p --output-format stream-json --verbose` 启动 headless Claude Code
- 增量解析每一行 JSON：`system.init` 抓 session_id、`assistant.tool_use` 抓工具调用、`user.tool_result` 抓工具结果、`result` 抓最终态
- 工具调用序列变成 `compressed_history` 给下游 verifier 用——verifier 能清楚看到"哪些文件被 Write / 哪些 Bash 失败"，不再因为 stream-json 体积大就被截断到啥都看不见
- AskUserQuestion 工具调用 / `NEED_CLARIFICATION:` 前缀 / 问句式 result text，三种"模型想问用户"的信号都识别并归一成 `worker_status=NEED_HELP`，再走 DECISION_REQUEST 链路自动弹决策面板
- session_id 在执行间保留：下一次派发到同一个 demand 时自动 `--resume <sid>`，对话连续。**这条直接解决"重新跑 Claude Code 上下文就丢"的体验问题**

### 3.3 渐进式反馈闭环

文件：`brain/store/memory_manager/service.ts` + `brain/dispatch/dispatcher/service.ts` + 各 handler。

每一次 verifier 验完都会写三条 memory：
- `mission_state`：当前任务状态摘要
- `episodic_trace`：本轮 worker 的压缩轨迹
- `lessons_or_policy`：从本轮失败 / 阻塞中提炼的经验

下一次 dispatch（无论是 retry、user replan、PARTIAL 自动 replan）从 memory 库取出最近 N 条，注入到新 `WorkerDispatchPacket.context_slice` 的 `shared_hints` / `relevant_history` / `mission_state_summary`。**worker 拿到 packet 时，能在 prompt 里直接读到"上一次为啥失败 / 应该怎么避开"**。

这是"长期变好"的最小可工作机制。没有这个，每次 retry 都只是把同样的事再做一遍指望命好。

### 3.4 两种 replan 形态都已闭合

| 类型 | 触发 | UI 体验 |
|---|---|---|
| **显式（plan review）** | 首次 plan / 用户点 Replan 按钮 / 用户在决策面板提反馈 | Plan Review 决策卡弹出，用户 Approve / 反馈 / Reject |
| **隐式（auto）** | worker 报 PARTIAL / verifier 判 PARTIAL | 不打扰用户，直接 replan，plan 版本号 +1 |

显式拦截的判定逻辑：`onPlanGenerated` 检查 `event.payload.reason`，只在 `initial_plan` / `user_triggered` / `replan_after_decision` 三种"方向变更"语义时拦。隐式 replan（`replan_after_result`）不拦。

这个分流避免了"每完成一个 subgoal 就要点一次 Approve"的疲劳体验，同时保证关键方向决定权在人手里。

---

## 4. 现状能 demo 什么

**端到端跑过的真实 demand**：
- "用 HTML5 Canvas 写一个坦克大战" → claude_code worker 写出 8 个文件（index.html / css / 5 个 .js），verifier 在我们最近一次修了 compressed_history 之后能正确判 VERIFIED_DONE
- "给我妈妈生日推荐一些盆栽" → opencode worker 写 markdown 文档，verifier 通过

**已经能在 UI 里看到的**：
- demand 创建 → 澄清对话 → Plan 面板出 plan outline + 各 subgoal 卡片
- 决策面板（Human Decision Panel）弹出：unverifiable / blocked / plan_review 三类决策都能正确弹
- 实时事件流（含每个 worker heartbeat、每个 verifier 判定）
- Replan 按钮：用户主动触发新一轮规划
- Settings 页面：四个模型角色（primary / planner / verifier / ops_backup）独立配置

**还没做完但接近**：
- 工具调用可视化：现在 adapter_meta 里有完整 tool trace，前端可以画一个"Claude 正在做什么"的实时小窗（4 周里程碑里见 §7）
- 多 worker 并行编排（目前是 selectWorker 选第一个匹配的）

---

## 5. 仓库布局速查

```text
framework-nodkit_v0.3.1/
├── server/                  ← TypeScript 后端（Express + ws + pino）
│   ├── src/
│   │   ├── app.ts           应用装配入口
│   │   ├── index.ts         server 启动 + 默认 worker 注册
│   │   ├── brain/           Brain 各模块（scheduler / engines / store / review / ops / dispatch）
│   │   ├── worker/adapters/ Worker 适配器（codex / opencode / claude_code + base + registry）
│   │   ├── interface/       HTTP 路由 + WebSocket 广播
│   │   └── domain/          类型 / 枚举 / zod 校验器（这层是协议唯一来源）
│   ├── data/                JSON 持久化（事件账本 + session + ...）
│   └── logs/                pino 日志（app.log）
├── web/                     ← React 18 + Vite 前端
│   └── src/App.tsx          主入口（决策面板 / Plan 面板 / Settings / 实时事件）
├── doc/                     设计规范（编号 .md，权威协议描述）
├── docs/pitch/              本文档目录（对内 / 对外材料）
└── 各 dev-*.sh / start-dev.sh   启动脚本（3 终端模式）
```

模块边界硬规则（doc/06_backend_module_boundaries.md 详）：
- Interface 层只 publish 事件，不改状态
- 只有 event handlers 能改 demand / subgoal / execution
- Adapter 不能直接读写 repo

新人 onboarding 时**最快的理解路径**：`server/src/brain/scheduler/handlers/eventHandlers/` 通读一遍，所有调度行为都在那里 ~1000 行。

---

## 6. Backlog（按优先级）

### P0：让 demo 能给大佬一遍跑过去（接下来 1-2 周）

- [ ] 一个"30 秒能讲明白"的 demo 脚本：现场 submit 一个真实 demand（不是坦克），让 claude_code 跑到 verified done，全程不接 LLM API key 之外的人工干预
- [ ] 把 settings 里的过期 dashscope key 换成稳定 endpoint；或加 Anthropic 直连作为 fallback
- [ ] verifier 准确率小修：当前 LLM verifier 偶尔在 worker 输出过长时判 unverifiable（实际已修过 compressed_history，但还可以再调）
- [ ] 把"工具调用可视化"小窗做出来——`adapter_meta.claude_tool_traces` 在前端展示，让大佬看到 Claude 正在 Read / Write / Bash 什么
- [ ] 文档 README 加一个"5 分钟跑起来"的 quick start

### P1：核心可托付性的最后一公里（4 周内）

- [ ] **后台运行**：现在 web UI 关掉 vite，demand 还跑，但用户拿不到新事件。要么让前端做后台轮询 + 通知，要么搞一个最小 standalone notifier
- [ ] **多 worker 并行**：当 plan 里多个 subgoal 没依赖时，可以同时派发给两个 worker。目前 selectWorker 只选第一个匹配的
- [ ] **隐式 replan 的次数预算**：现在 worker 报 PARTIAL → 自动 replan，没有上限。需要 settings.runtime.max_implicit_replan_count
- [ ] **认证与 multi-tenant 最小模型**：现在所有 demand 共享一个 settings.json。要让真正的"我 / 我老婆 / 我老板"各自有独立 workspace + key + 历史
- [ ] **真实 use case ramp**：选 2 个内部用户（建议 <<TODO: 名字 1>> 和 <<TODO: 名字 2>>），让他们每周提 3 个真实 demand，统计 verified done rate / 阻塞类型分布

### P2：变成产品的事

- [ ] 通知通道（email / 飞书 / TG bot）
- [ ] Web 上对 plan / event 历史的检索 + 时间线视图
- [ ] Demand 模板库（提醒类 / 研究类 / 构建类 / 操作类四种最小模板）
- [ ] Worker 注册 / 卸载 UI（目前只能改 workers.json）

### P3：远景但要标记

- [ ] **跨 demand memory 联邦**：当前 memory 按 demand 隔离。但很多场景 "我妈生日"这类 demand 应该跨次复用历史
- [ ] **多人协作**：一个 demand 多个用户参与决策（产品经理 + 工程师在同一 demand 上各自接 plan-review）
- [ ] **Worker SDK**：开放给第三方接入更多 agent 工具（aider / cline / 自定义 SaaS）

---

## 7. 接下来 4 周里程碑

| 周 | 主题 | 必交付 | 验收点 |
|---|---|---|---|
| W1 | demo 收口 + 文档 | quick start README、demo 脚本、tool trace 小窗 | 一个完全陌生的工程师能在 30 分钟内本地跑起来一个 demand 看到完成 |
| W2 | verifier / 反馈循环数据化 | verifier 准确率 baseline、memory 注入效果对比、cost / latency 数据 | 拿出"加 memory 注入后 verified_done rate 从 X% 提到 Y%"这种可量化结论 |
| W3 | 真实用户接入 | 2 个内部用户每天用、5+ demand types 跑通、bug list | 收到至少 30 条真实 demand，verified done rate >= 60%，每条都有事件账本可复盘 |
| W4 | 对外 demo 包 + 路演 | 外部 brief 终稿（`docs/pitch/external.md`）、3 个 demo 视频、初始用户证言 | <<TODO: 列出要见的 2-3 位大佬>> 看完文档至少有一个表示愿意进一步聊 |

---

## 8. ASK

**钱**（用于 W1-W12，3 个月）：
- LLM API 预算 <<TODO: 估算每月 token 量 + 单价>>
- 算力：现在 worker 全跑在开发机本地，长期需要 <<TODO: 独立 server / 容器>>
- 工具订阅：Claude Code Pro / OpenAI / 其他

**人**：
- 前端 1 人：负责 Plan 面板 / 决策面板 / 实时事件流的体验深化
- 后端 1 人：负责 multi-worker 并行 / 后台运行 / 通知通道
- LLM 调优 / verifier 准确率 0.5 人（可以是兼职 / 实习）
- 自己 + <<TODO: 现有 co-founder 或核心同事名字>> 继续作为系统设计 + 路线决策

**用户接入**：
- 2 个内部 beta 用户的"用例承诺"——他们承诺接下来 4 周每天用 Nodikt 处理至少 1 个真实需求
- 1 个早期外部用户（建议从 <<TODO: 你认识的 PM / 研究员 / 创业者朋友>> 里挑）

**时间**：
- 大佬决策窗口建议 <<TODO: 多少天内决定>>
- 我们这边的弹药能撑到 <<TODO: 哪个月>>，那之前需要拿到上面 ask

---

## 9. 风险与对策

| 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|
| base model 一年内自己就能"稳态推进" | 中 | 高 | 我们打的是"系统层 + 长期 memory + 事件账本"，model 再强这些都还要外面有人做；持续打磨这些差异 |
| Multica / OpenHands / 某大厂直接做同一形态产品 | 中 | 中 | 速度 + 用户接入护城河；4-12 周内拿到真实场景的"我离不开"用户 |
| verifier 误判过高，用户体验崩 | 高 | 中 | W2 专门数据化打底；artifact 存在性 + LLM 验证 + 用户兜底三层 fallback 已有 |
| Claude Code / 等闭源 worker 协议突变 | 中 | 中 | adapter 层隔离，base 协议是统一 contract；新协议可在 1 周内适配 |
| 用户期望"一次性大胖子" | 高 | 中 | 我们的定位本来就是反过来的，做好教育 + 把"小步推进"的速度感做到肉眼可见 |

---

## 10. 给小伙伴的 onboarding 路径

新人加入第 1 天看：
1. `README.md`（仓库根，最高频信息）
2. `Nodikt_项目定义文档_稳态推进版.md`（vision + 协议）
3. 本文档（现状 + 路线）

第 1 周内要做完的事：
1. 本地跑通 3 终端开发模式（`./dev-tsc.sh` / `./dev-server.sh` / `./dev-web.sh`）
2. 提交一个真实 demand，全程跟踪它在 events.json 里的事件链
3. 选一个 P0 任务接，挂自己名字

需要快速理解架构时的"四个文件就够"：
- `server/src/brain/scheduler/event_bus/eventBus.ts` — 调度主回路
- `server/src/brain/scheduler/handlers/index.ts` — handler 注册全景
- `server/src/worker/adapters/claudeCodeAdapter.ts` — 协议适配的示范
- `web/src/App.tsx` — 决策面板 / Plan 面板的渲染逻辑

需要写新 Worker 时跟 `claudeCodeAdapter.ts` 抄一遍架子，重写 `resolveCommand` 和 `onStdoutLine` 即可。

---

## 11. 配套文档

- `docs/pitch/external.md`：对外 3-4 页 executive brief
- `Nodikt_项目定义文档_稳态推进版.md`：vision / 架构 / schema / interface 的权威定义
- `doc/01-09_*.md`：scheduler / worker / 事件 / 前端各层的设计规范
- `CLAUDE.md`：仓库总体说明（给 Claude Code 自己看的，但人也能读）
- `.env.example`：环境变量清单（含 Claude Code 接入配置）

---

> _本文是事实快照，会随实现进度迭代。修改请走 PR，标题前缀 `[pitch]`，方便后续追溯团队对路线的认知变化。_
