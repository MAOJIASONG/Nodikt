<div align="center">

<img src="https://github.com/user-attachments/assets/a271e371-6d22-438b-b996-fcfd8a0c919f" alt="Nodikt Banner" width="100%"/>

# 🧠 Nodikt

### 人类意图的操作系统
### *The Operating System for Human Intent*

<br/>

> **Definition by Human. Execution by Protocol. Manifestation by AI.**
>
> 人定义，协议转译，AI 显化。

<br/>

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Python](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/)
[![Status](https://img.shields.io/badge/status-In%20Development-yellow.svg)]()

</div>

---

## 一、项目概述与核心愿景

### 1.1 项目名称

**Nodikt：人类意图的操作系统（The Operating System for Human Intent）**

### 1.2 核心愿景

**终结微观项目管理，开启结果显化时代。**

在 Nodikt 中，人类作为 **"意图架构师（Architect of Will）"**，只需定义目标与验收标准。系统通过高度自主、具备自我修复能力的分布式 AI 节点网络，将人类的抽象意图直接转化为具象的现实成果。

### 1.3 核心 Slogan

```
Definition by Human. Execution by Protocol. Manifestation by AI.
（人定义，协议转译，AI 显化。）
```

---

## 二、全新三层物理架构（The Triad Architecture）

系统整体被拆分为三个解耦的物理层，以应对高延迟的分布式网络和复杂的异步协作：

```
┌─────────────────────────────────────────────────────────┐
│                    🖥️  Interface 层                      │
│                  感知与控制界面 (Web/App)                  │
└──────────────────────────┬──────────────────────────────┘
                           │ 多模态输入 / 控制指令
┌──────────────────────────▼──────────────────────────────┐
│                    🧠  Brain 层                          │
│          中枢大脑 · 调度 · 规划 · 自愈 · 验收              │
└──────┬───────────────────┬───────────────────┬──────────┘
       │     DDXP 协议      │                   │
┌──────▼──────┐    ┌───────▼──────┐    ┌───────▼──────┐
│  🛠️ Worker  │    │  🛠️ Worker  │    │  🛠️ Worker  │
│   Node A    │    │   Node B    │    │   Node N    │
└─────────────┘    └─────────────┘    └─────────────┘
```

---

### 🖥️ 1. Interface 层（感知与控制界面）

人类与系统交互的唯一入口，形态为 Web/App 端。

| 功能模块 | 说明 |
|----------|------|
| **多模态对话框** | 支持自然语言、命令（如 `/workspace`）及多模态输入，直接转发至 Brain |
| **Dashboard 看板** | 全局状态的可视化中心，包含任务时间线（类甘特图）、全量 Demand 列表及底层动态拆解的 Task |
| **绝对控制台** | 赋予人类最高权限，支持直接修改任务、一键暂停/中止特定 Task 流程，或直接杀死整个 Demand |
| **Async Worker 监控站** | 每 10 分钟刷新一次全球 Worker 的在线状态（Alive）、配置、能力清单及系统信息 |

---

### 🧠 2. Brain 层（中枢大脑）

Nodikt 的核心基石。它不仅是一个调度器，更是一个**具备自我感知和修复能力的稳健系统**，远比传统的单体 Agent 框架更加鲁棒。

#### LLM Inference Engines

底层大模型推理引擎，通过面向对象的 Class 封装，对外提供标准的 Function Call 能力。

#### Ops（高可用运维机制）

系统的 **"不死鸟"** 模块，构建三层防御网：

```
网络级防御  →  持续监控 Brain 运行状况与 API 健康度
逻辑级防御  →  Auto-fix 语法糖机制，拦截并解析错误，尝试自动修复代码或逻辑
模型级防御  →  安全抱死（Fall-back）：云端大模型宕机时，自动切流至本地模型（如 Qwen3.5-4B）兜底
                                  ↓
                    求救通道：遇到无法逾越的系统级障碍，向人类发出求救信号
```

#### The Living Scheduler（动态调度器）

事件驱动的异步状态机，核心职责：

- 理解多模态输入，维护上下文
- 生成 Subgoals，利用 DDXP 协议进行路由分发与结果验收
- 发挥所有权（Ownership）精神，主动补全和丰满人类的计划

---

### 🛠️ 3. Workers 层（分布式执行节点）

部署在异构设备上的执行单元。

| 特性 | 描述 |
|------|------|
| **独立且无状态** | Worker 之间绝对互不通信，仅通过 Git / Pull Request / 文件系统与 Brain 进行结果交互 |
| **受限反馈机制** | 执行过程中遇到阻碍不硬磕，只能向 Brain 发出高层事件反馈 |

**Worker 反馈事件类型：**

```
ResultSubmitted   →  完成验收
Blocked           →  遇阻挂起（包含：需人类批准 / 报错 / Token/算力预算耗尽 等）
```

---

## 三、核心通信协议与数据结构

### 3.1 DDXP（分布式需求交换协议）

连接 Brain 与 Workers 的**异步通信标准**，核心是传递**目标和交付成果**，而非具体的过程指令。

### 3.2 SubgoalContract（子目标契约）

Scheduler 下发给 Worker 的执行凭证，彻底杜绝 AI 的"过度发散"。SubgoalContract 包含：
- 明确的可验收目标（Acceptance Criteria）
- 必要的上下文切片（Context Slice）
- 资源预算限制（Token / 算力 Budget）
- 超时与熔断条件

### 3.3 分层记忆系统（Memory Management）

Brain 内部维护严密的**三层记忆切片**，用于支持长程规划和滚动更新：

```
┌─────────────────────────────────────────────────────────┐
│  Layer 1: MissionState（客观任务状态）                    │
│           全局目标 · Dependency Graph · 已验收产物          │
├─────────────────────────────────────────────────────────┤
│  Layer 2: EpisodicTrace（近期执行轨迹）                   │
│           Worker 行为记录 · 报错历史 · 近期执行轨迹          │
├─────────────────────────────────────────────────────────┤
│  Layer 3: LessonsOrPolicy（经验与策略）                   │
│           避坑指南 · 失败模式 · 可复用 Skill（自进化基础）   │
└─────────────────────────────────────────────────────────┘
```

---

## 四、核心工作流：多步滚动规划（Multi-step Planning）

Nodikt 摒弃了僵化的"一次性规划全部流程"，采用更符合软件工程现实的策略：

> **高层目标恒定，底层回合滚动更新**

```
Step 1  意图发起（Inception & Clarification）
    │   人类输入 Demand → Scheduler 对话确认细节
    │   输出：Operational Objective（可执行目标）
    ▼
Step 2  长程规划与依赖提取（Rolling Planning）
    │   结合 MissionState + ArtifactEvidence，构建全局依赖图
    │   只选取当前第一层、依赖已解决的前沿子任务（Frontier Subgoals）
    ▼
Step 3  能力调度与派发（Capacity Scheduling）
    │   检查 Worker 池，寻找空闲且能力/权限匹配的节点
    │   打包 SubgoalContract + 上下文切片，派发至 Worker
    ▼
Step 4  自主执行与熔断返回（Worker Execution）
    │   Worker 在本地闭门执行
    │   达到契约条件（完成 / 超时 / Blocked）→ 通过 Git 提交 WorkerResult
    ▼
Step 5  严格验证与收编（Verifier & Reconciliation）
    │   Verifier 直接检查文件系统/代码库的证据，绝不轻信 Worker 的"一面之词"
    │   验证通过 → Reconciliation：接纳产物，更新 MissionState + LessonsOrPolicy
    ▼
Step 6  重新规划（Replan）
        根据最新状态重新评估依赖图，抽取下一批 Frontier Subgoals
        循环往复，直到最终显化完成 ✅
```

---

## 五、系统的终极护城河

### 🔒 1. 绝对的人类主权（User Interrupt Channel）

任何时刻，用户的输入（暂停、修改需求、切断 Worker）具有**最高系统优先级**：

```
用户输入指令
    → Interface 即时接收
    → Scheduler 立即 preempt（抢占/中止）当前计划
    → 刷新全局状态
    → 瞬间 Replan
```

### 🛡️ 2. 自我疗愈的 Ops 引擎

常规 AI 助手崩溃即死，Nodikt 依靠 Ops 模块实现三层防御：

| 防御层级 | 覆盖范围 | 手段 |
|----------|----------|------|
| 网络级 | API 连通性检测 | 自动重试 / 切换端点 |
| 逻辑级 | 代码 / 逻辑错误 | Auto-fix 语法糖机制 |
| 模型级 | 云端大模型宕机 | 本地 Qwen 模型自动兜底 |

### 🌐 3. 去中心化的算力即插即用

由于 Worker 只认 DDXP 协议且互不通信，Nodikt 可以**无限外挂全球任何一台机器**作为算力节点，打造真正意义上的分布式智能包工队。

---

## 快速开始

> 🚧 **项目正在积极开发中**，以下为规划中的使用方式，完整的安装与使用文档将随版本迭代持续更新。

```bash
# 克隆仓库
git clone https://github.com/MAOJIASONG/Nodikt.git
cd Nodikt

# 安装依赖（requirements.txt 将随首个可用版本一同发布）
pip install -r requirements.txt

# 启动 Brain 服务（以下模块路径为规划中的实现，尚未发布）
python -m nodikt.brain

# 启动 Interface
python -m nodikt.interface
```

---

## 贡献指南

欢迎参与 Nodikt 的建设！贡献指南（CONTRIBUTING.md）即将发布，敬请期待。

---

## 许可证

本项目采用 [MIT License](LICENSE) 授权。

---

<div align="center">

**Nodikt** · 终结微观管理，开启意图显化新时代

*Built with ❤️ by the Nodikt Team*

</div>
