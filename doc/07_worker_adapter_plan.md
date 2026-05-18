# Nodikt Worker Adapter Plan v1

## Summary

Nodikt v1 接入 `codex`、`opencode`、`claude_code` 三类 worker，全部通过统一 adapter contract 接入 Scheduler：

- `register(config)`
- `startExecution(packet)`
- `stopExecution(execution_id)`
- `pollStatus(execution_id)`
- `collectResult(execution_id)`
- `healthCheck(worker_id)`

adapter 只负责协议适配、进程/会话托管、heartbeat 合成、结果归一化，不负责业务状态迁移。

## Shared Rules

- Scheduler 只理解统一协议，不理解 CLI 私有参数
- 任何安装 skill / 依赖的需求都必须转成 `INSTALL_REQUIRES_REVIEW`
- 只允许 `workspace_only` 安装范围，不允许全局安装
- heartbeat 由 adapter 合成，不要求底层 worker 原生支持
- `WorkerResult` 只是执行声明，不代表系统完成
- adapter 不得直接修改 demand / subgoal / execution / decision 状态

## Codex Adapter

### Registration

- `adapter_type = "codex"`
- `runtime_type = "local_command"`
- `command` 通常为 `codex`
- `args` 可为空或由 deployment 注入
- `workspace_root` 指向当前 demand 的工作目录

### Execution

- `startExecution(packet)` 启动本地子进程
- adapter 维护 `execution_id -> child_process` 映射
- 标准输入可选，不要求 v1 强制交互流
- 输出采集：
  - `stdout`
  - `stderr`
  - 退出码
  - 工作区 artifact 扫描结果

### Heartbeat

- 进程存活且最近有输出：`running`
- 进程存活但长时间无输出：`running`，附带静默说明
- 进程退出且退出码非 0：后续 result 归一为 `FAILED`
- 进程退出且有可用产物：可归一为 `DONE` 或 `PARTIAL`

### Result Mapping

- 正常退出且满足最小输出要求：`DONE`
- 正常退出但缺少成功证据：`PARTIAL`
- 非零退出：`FAILED`
- 输出包含缺权限/需人工信息：`NEED_HELP` 或 `BLOCKED`

## OpenCode Adapter

### Registration

- `adapter_type = "opencode"`
- `runtime_type = "local_command"`
- `workspace_root` 指向当前 demand 的工作目录
- `command = "bash"`
- `args` 指向 `opencode/opencode_run.sh` 或等效启动命令
- `env.HOME = ${OPENCODE_RUNTIME_HOME}`（默认 `./.opencode-runtime`）
- `env.PATH` 需要追加 `${OPENCODE_INSTALL_ROOT}/bin`

### Execution

- 首轮不改造 `opencode` 本体代码
- 通过 CLI 子进程方式托管运行
- adapter 负责：
  - 注入环境变量
  - 托管子进程生命周期
  - 记录 stdout/stderr
  - 轮询运行态
  - 根据退出码与日志归一结果

### Heartbeat

- 子进程活跃时周期性发送 `WorkerHeartbeat`
- 若存在增量输出，`source = "event_stream"`
- 若仅通过进程存活探测得出状态，`source = "status_poll"`
- 超过 `settings.runtime.execution_timeout_seconds` 仍未结束，由 ops monitor 触发 timeout 路径

### Result Mapping

- 正常退出且有明确交付物：`DONE`
- 正常退出但证据不足：`PARTIAL`
- 命令失败或退出码非 0：`FAILED`
- 输出明确要求更多信息：`NEED_HELP`
- 输出明确显示环境阻塞或权限阻塞：`BLOCKED`

## Health Check

两个 adapter 都必须支持：

- 校验 `command` 是否可执行
- 校验 `workspace_root` 是否存在
- 返回最近错误
- 返回最后心跳时间

## Stop / Poll / Collect Responsibilities

- `stopExecution(execution_id)`：发中断信号并更新本地 runtime 记录
- `pollStatus(execution_id)`：返回统一 heartbeat 视图
- `collectResult(execution_id)`：整合日志、退出码、artifact 扫描与 adapter metadata，输出统一 `WorkerResult`

## Notes

- 首轮优先保证 contract 正确、状态机边界正确、可观测性正确
- 不追求一次性完成所有 codex/opencode 私有能力封装
- 若未来 `opencode` 增加 HTTP 模式，只允许在 adapter 内部扩展，不改变 Scheduler 协议
