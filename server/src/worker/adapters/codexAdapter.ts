/**
 * 文件名称：codexAdapter.ts
 * 文件作用：Codex 本地工作器适配器，负责将调度任务转换为 Codex CLI 命令执行。
 *
 * 主要职责：
 * 1. 定义 Codex 适配器类型和默认命令。
 * 2. 构造发送给 Codex 的任务提示词。
 * 3. 复用本地命令适配器基类完成执行生命周期管理。
 *
 * 依赖模块：
 * - BaseLocalCommandAdapter：本地命令工作器通用实现。
 * - domain：工作器注册和派发包类型。
 *
 * 注意事项：
 * - 提示词结构会直接影响工作器产出质量，修改时需兼顾调度协议。
 * - 命令参数应保持非交互式，避免阻塞调度流程。
 */
import { WorkerDispatchPacket, WorkerRegistration } from "../../domain/index.js";
import { BaseLocalCommandAdapter } from "./baseLocalCommandAdapter.js";

export class CodexAdapter extends BaseLocalCommandAdapter {
  /**
   * 函数作用：解析 Codex 工作器执行命令。
   *
   * 参数说明：
   * - worker：工作器注册配置。
   * - packet：本次执行的派发包。
   *
   * 返回值：
   * - 返回命令、参数、环境变量和工作目录配置。
   */
  protected resolveCommand(worker: WorkerRegistration, packet: WorkerDispatchPacket) {
    return {
      command: worker.config.command ?? "bash",
      args: worker.config.args ?? [
        "-lc",
        `echo "Codex execution ${packet.execution_id}"; echo "${packet.subgoal_contract.objective}"`
      ],
      env: worker.config.env ?? {},
      cwd: worker.config.workspace_root
    };
  }
}
