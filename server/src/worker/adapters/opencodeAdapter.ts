/**
 * 文件名称：opencodeAdapter.ts
 * 文件作用：OpenCode 本地工作器适配器，负责将调度任务转换为 OpenCode CLI 命令执行。
 *
 * 主要职责：
 * 1. 解析 OpenCode 命令路径和运行环境。
 * 2. 构造 OpenCode 可消费的任务提示词。
 * 3. 复用本地命令适配器基类管理执行、心跳和取消。
 *
 * 依赖模块：
 * - BaseLocalCommandAdapter：本地命令工作器通用实现。
 * - opencodeRuntime：OpenCode 安装路径和环境变量解析。
 * - domain：工作器注册和派发包类型。
 *
 * 注意事项：
 * - 运行环境变量会影响 OpenCode 配置、缓存和模型访问。
 * - 修改命令构造时，应确认 Windows 与跨平台路径处理仍然可用。
 */
import { WorkerDispatchPacket, WorkerRegistration } from "../../domain/index.js";
import { BaseLocalCommandAdapter } from "./baseLocalCommandAdapter.js";
import { getOpenCodeRuntimeEnv, resolveOpenCodeCommand } from "./opencodeRuntime.js";

export class OpenCodeAdapter extends BaseLocalCommandAdapter {
  /**
   * 函数作用：从派发包环境说明中读取工作区路径。
   *
   * 参数说明：
   * - packet：本次执行的派发包。
   * - worker：工作器注册配置。
   *
   * 返回值：
   * - string：优先使用派发包中的 workspace_root，否则回退到工作器配置。
   */
  private readWorkspaceRoot(packet: WorkerDispatchPacket, worker: WorkerRegistration): string {
    const note = packet.context_slice.environment_notes.find((item) => item.startsWith("workspace_root="));
    return note ? note.slice("workspace_root=".length) : worker.config.workspace_root;
  }

  /**
   * 函数作用：构造发送给 OpenCode 的任务提示词。
   *
   * 参数说明：
   * - packet：本次执行的派发包。
   * - worker：工作器注册配置。
   *
   * 返回值：
   * - string：包含需求、子目标、验收标准和工作区信息的提示词。
   */
  private buildPrompt(packet: WorkerDispatchPacket, worker: WorkerRegistration): string {
    return [
      `Demand: ${packet.clarified_demand}`,
      `Subgoal: ${packet.subgoal_contract.title}`,
      `Subgoal objective: ${packet.subgoal_contract.objective}`,
      `Success criteria: ${packet.subgoal_contract.success_criteria.join("; ")}`,
      `Constraints: ${packet.subgoal_contract.constraints.join("; ")}`,
      `Workspace root: ${this.readWorkspaceRoot(packet, worker)}`,
      "Execute the coding task directly in the workspace root.",
      "Create or modify the necessary files only for this subgoal.",
      "When finished, exit the process so the scheduler can collect the result."
    ].join("\n");
  }

  /**
   * 函数作用：解析 OpenCode 工作器执行命令。
   *
   * 参数说明：
   * - worker：工作器注册配置。
   * - packet：本次执行的派发包。
   *
   * 返回值：
   * - 返回命令、参数、环境变量和工作目录配置。
   */
  protected resolveCommand(worker: WorkerRegistration, packet: WorkerDispatchPacket) {
    const workspaceRoot = this.readWorkspaceRoot(packet, worker);
    const openCode = resolveOpenCodeCommand();
    return {
      command: openCode.command,
      args: [
        ...openCode.argsPrefix,
        "run",
        "--format",
        "json",
        "--title",
        packet.subgoal_contract.title,
        this.buildPrompt(packet, worker)
      ],
      env: {
        ...(worker.config.env ?? {}),
        ...getOpenCodeRuntimeEnv(worker.config.env?.PATH),
        NODIKT_EXECUTION_ID: packet.execution_id,
        CI: "1"
      },
      cwd: workspaceRoot
    };
  }
}
