# Nodikt

> **Human Intent OS — 让 AI 从需要看着跑，变成可以托付的执行系统**

作者 <<TODO: 你的名字>>　|　最后更新 2026-05-16　|　对接 <<TODO: 邮箱 / 微信>>

---

## 1. 一句话讲完

当代 AI agent 解决了"单次能力"。Nodikt 解决"长跑能力"——让你提交一个 demand 之后**可以离开工位**，回来时任务要么推进了一步，要么明确告诉你卡在哪、为什么、下一步该怎么动。

## 2. 我们为什么押这条赛道

打开任何一个主流 agent 产品，你会发现一个共同体验：

> "Cursor 跑了，我得盯着它别走偏。"
>
> "Claude Code 报错了，上下文断了，我得从头讲一遍。"
>
> "我提了个 demand，过了一晚上回来发现它静默卡在第二步——什么提示都没有。"

**这是这一代 agent 的真正瓶颈，不是它单次跑得不够猛，而是它跑得没办法让人放心离开。**

我们押三个判断：

1. **单次任务表现会随 base model 自然变强**——这不是系统层值得投入的事。一年后 Claude 5 / GPT 5 自己就够准了。
2. **真正反复出现、还没被工程化解决的问题，是"盯盘焦虑"**——上下文丢失、静默失败、恢复成本高、没通知机制。这些问题没法靠模型变强解决，它们是**系统层**的问题。
3. **当 AI 从工具变成基础设施**，一定要有人造出那一层"OS"——有状态、有事件账本、可恢复、有兜底、能反馈。这是我们做的事。

类比一下：单个 model 像 CPU，没有 OS 直接给应用层是混乱的；现在所有 agent 产品都在直接拿 CPU 编程，缺一个 OS。

## 3. 我们做了什么（不是 PPT，是已经在跑的代码）

我们不是 deck-stage。仓库里有一套已经端到端跑通的实现：

- **事件溯源调度器**：所有控制流是代码（hardcode），不是 prompt。每一次状态推进都有事件留底，可以原样重放。这是我们和"靠提示词编排 agent"那类系统最根本的区别。
- **三层 memory + 渐进式反馈闭环**：每一轮 worker 完成后，verifier 把"任务状态 / 本轮轨迹 / 教训"写进结构化 memory；下一轮派发自动把这些 lessons 注入到 worker 的 prompt。**worker 不会一次次重蹈覆辙，系统会越跑越聪明。**
- **接入 Claude Code 等内嵌 agent 工具**：用 stream-json 协议解析它的工具调用、问答信号、session id。Claude Code 在我们这里不是黑盒，前端可以看到它正在 Read / Write / Bash 什么；它向人提问时自动弹决策面板；下一次派发自动 `--resume <session_id>` 续接对话。**这条路径把"接入任意第三方 agent 工具"做成了可复制的范式**。
- **两种 replan 形态**：
  - 显式（用户审核）——plan 一刚生成弹卡片，用户 Approve / 提反馈 / Reject；提反馈会触发新一轮规划，再次审核。
  - 隐式（worker 自报）——worker 觉得"做完了但不彻底"，系统自动重规划，不打扰用户。
- **完整的人机决策通道**：unverifiable / blocked / 缺权限 / 缺工具 / 计划审核，五种"系统拿不准"的场景都会弹决策面板，给用户**结构化的选项**而不是"自己想办法"。

实际跑过的 demand 样例：

> _"用 HTML5 Canvas 写一个坦克大战"_ → claude_code worker 一轮写出 8 个文件（HTML / CSS / 5 个 JS 模块 / verify 脚本）；verifier 看到完整工具调用历史后判 VERIFIED_DONE；产物可直接 `python3 -m http.server` 打开玩。
>
> _"给我妈妈生日推荐一些盆栽"_ → opencode worker 写 9KB 调研 markdown；verifier 通过；用户直接拿去看。

## 4. 我们与现有玩家的差异

| 类别 | 代表 | 关注 | Nodikt 的差异 |
|---|---|---|---|
| **单 agent 工具** | Cursor / Cline / Claude Code | 单次代码协作 | 我们不是工具，是上层 OS。这些工具是我们的 worker |
| **Coding agent 框架** | OpenHands / Aider | 透明可控的 coding loop | 我们把它们接进来，附加调度 / 验证 / memory / 兜底 |
| **Workflow / Agent SDK** | LangGraph / Temporal | 可恢复的 stateful 工作流 | 我们用同一套工程范式，但针对 AI 任务做了 verifier、人机决策、渐进反馈 |
| **Managed Agent 平台** | Anthropic Managed Agents / Multica | 长任务管理 + 看板 | 同一赛道，但我们押"用户必须保留所有权"——所有事件、memory、worker 都开放可控 |
| **横向 agent 产品** | Devin / Manus | 单 demand 端到端跑通 | 我们不替用户做决定，而是把决策权清晰交还，让 demand 可以被多轮迭代 |

**护城河的真实形态**不是"模型选得好"或"prompt 写得妙"，是：
1. 调度控制是工程化的代码（可观测 / 可恢复 / 可监控）
2. 长 demand 的 event store + memory 累积出来的"用户专有上下文"——越用越懂你
3. 接入新 worker 的范式标准化，跟谁兼容都是 1 周内的事

## 5. 高 ROI 的典型场景

**场景 A：研发型用户**
> 周五下午丢一句 _"把这个仓库的认证模块按 OWASP 2025 标准重构一遍，加上单测覆盖率到 90%"_。周末离开。周一回来：Nodikt 已经迭代了 4 轮 plan，每轮失败都自动反馈给下一轮 worker；周日凌晨 verifier 通过，等你最终 review。

**场景 B：知识型用户**
> _"帮我盯一下 OpenAI 这个月所有公开的 API breaking change，每周一早上把对我们项目的影响汇总成 markdown 给我"_。周期性 demand，每周自动跑一次，结果直接邮箱通知。

**场景 C：生活型用户**
> _"我妈下周一生日，根据她过去 3 年送过的礼物和近况，列 5 个候选并下单最合适的那个"_。这种 demand 一旦定义清楚，可以变成跨年的执行流——不是一次性任务，是真正的"代理"。

三种场景的共性：**用户提交完就走，系统自己持续推进，反馈准时到位。**

## 6. 我们的进度

- **代码完成度**：核心闭环已经端到端通跑（事件总线 / 三层 memory / 计划审核 / 隐式 replan / Claude Code 集成）；本地一键启动；3 个内部用户在用
- **真实 demand 历史**：累计跑过 <<TODO: 数量>>+ 个不同类型的 demand，verified done rate 当前 <<TODO: 比如 65%>>，4 周内目标提到 85%
- **接入 worker**：opencode / claude_code / codex 三类已接通，接口设计支持任意 stream-json 形态的第三方工具
- **架构稳定性**：scheduler 已经过 <<TODO: 多少次>>+ 次重启 + 恢复，无数据损坏；event 账本完整可重放

## 7. 团队

<<TODO: 团队介绍 — 推荐每人 1-2 行：姓名、背景一句话、负责什么。例如：>>

- **<<TODO: 你的名字>>**：系统设计 + 路线 + 全栈实现。<<TODO: 背景一行>>
- **<<TODO: 协作者 1>>**：<<TODO: 负责什么 + 背景一行>>
- **<<TODO: 协作者 2>>**：<<TODO: 负责什么 + 背景一行>>

**为什么是我们**：第一性原理思考 + 工程落地能力 + 对"用户托付感"这件事的真正在意。这条赛道难的不是写代码，是判断"哪些事其实是用户层不应该管的"，这需要 vision 和耐心。

## 8. 接下来 3 个月

| 节点 | 关键交付 |
|---|---|
| **第 4 周** | demo 收口 + 2 个内部用户每天在用 + verifier 准确率打底数据 |
| **第 8 周** | 5 个真实外部用户接入 + verified done rate 稳定 ≥ 80% + 通知通道（邮件 / 飞书） |
| **第 12 周** | 跨 demand memory 联邦 + 后台运行 + multi-worker 并行 + 至少 3 个用户证言 |

**这 3 个月做出来后**：我们要能给出"X 用户在过去 30 天内通过 Nodikt 完成了 Y 个 demand，节省了 Z 小时盯盘时间"这种硬数字。

## 9. Ask

**我们需要**：

- **资金 <<TODO: 数额 + 用途比例（人 / API / 算力）>>**，撑 3-6 个月
- **<<TODO: 几个 headcount>>** 个工程岗（详见 `docs/pitch/internal.md` §8）
- **<<TODO: 几位>>** 名早期用户接入（关键：每周稳定使用，提供反馈与真实 demand）
- **<<TODO: 是否需要>>** 算力 / API quota 资助：每月 API token 用量预估 <<TODO: 数字>>

**我们提供**：

- 完整代码所有权 / 知识产权透明
- 用户专有的事件账本 + memory 存储——这层数据将是长期资产，不归任何模型供应商
- 一个能跟你聊 5 年的技术合作关系，不是 6 个月就被验证完的赌注

## 10. 立即可看的事

1. 仓库：<<TODO: GitHub / Gitlab 链接>>
2. 5 分钟跑通：`git clone && ./start-dev.sh`，详见仓库根 README
3. Demo 视频：<<TODO: 链接>>
4. 详细架构 + 进度：`docs/pitch/internal.md` + `Nodikt_项目定义文档_稳态推进版.md`
5. 想直接看一个端到端跑：<<TODO: 你的微信 / 邮箱>>，我可以现场屏幕共享 20 分钟过一遍

---

> _"Don't bet on the model getting smarter. Bet on the system getting more trustworthy."_
>
> — Nodikt
