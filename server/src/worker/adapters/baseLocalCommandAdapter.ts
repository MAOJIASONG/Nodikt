/**
 * 文件名称：baseLocalCommandAdapter.ts
 * 文件作用：本地命令型工作器适配器基类，封装子进程执行、运行时记录和结果收集逻辑。
 *
 * 主要职责：
 * 1. 注册本地命令工作器并维护运行中执行记录。
 * 2. 将 WorkerDispatchPacket 转换为具体命令行调用。
 * 3. 收集 stdout、stderr、退出码和产物文件信息。
 * 4. 提供心跳、取消和注销等通用适配器能力。
 *
 * 依赖模块：
 * - child_process：启动本地工作器进程。
 * - fs/promises：扫描工作区产物文件。
 * - worker/adapters/contract：工作器适配器接口。
 *
 * 注意事项：
 * - 子类只应关注命令构造和提示词构造，通用生命周期逻辑放在本基类。
 * - 进程取消和结果归档会影响调度状态推进，需要保持返回结构稳定。
 */
import { spawn, ChildProcessByStdio } from "child_process";
import { mkdir, readdir, stat } from "fs/promises";
import { Readable } from "stream";

import {
  createId,
  WorkerDispatchPacket,
  WorkerExecutionStatus,
  WorkerHeartbeat,
  WorkerRegistration,
  WorkerResult,
  WorkerResultStatus,
  nowIso
} from "../../domain/index.js";
import { WorkerAdapter } from "./contract.js";

interface RuntimeRecord {
  workerId: string;
  cwd: string;
  process: ChildProcessByStdio<null, Readable, Readable>;
  startedAt: number;
  stdout: string[];
  stderr: string[];
  stdoutLineBuffer: string;
  exitCode: number | null;
  finishedAt: number | null;
  errorMessage: string | null;
  resultCollectedAt: number | null;
}

export abstract class BaseLocalCommandAdapter implements WorkerAdapter {
  protected readonly runtimeByExecution = new Map<string, RuntimeRecord>();
  protected readonly workerConfigs = new Map<string, WorkerRegistration>();

  /**
   * 函数作用：子进程标准输出每完成一行就触发的钩子。
   *
   * 参数说明：
   * - executionId：当前执行 ID。
   * - line：以换行符切割得到的完整一行（不含换行符）。
   *
   * 返回值：
   * - void：默认空实现，子类可覆盖以增量解析行式协议（如 stream-json）。
   *
   * 注意事项：
   * - 钩子在 close 时会被调用一次以冲洗未结尾的最后一段缓冲区。
   * - 子类内部状态应以 executionId 维护，避免污染基类记录。
   */
  protected onStdoutLine(executionId: string, line: string): void {
    void executionId;
    void line;
  }

  /**
   * 函数作用：子进程 close 时触发的钩子，便于子类做收尾。
   */
  protected onProcessClose(executionId: string, exitCode: number | null): void {
    void executionId;
    void exitCode;
  }

  private stripAnsi(input: string): string {
    return input.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
  }

  private summarizeText(input: string, maxLength = 280): string {
    const clean = this.stripAnsi(input).replace(/\s+/g, " ").trim();
    return clean.length > maxLength ? `${clean.slice(0, maxLength - 3)}...` : clean;
  }

  private getLastLine(lines: string[]): string | null {
    if (lines.length === 0) {
      return null;
    }
    const merged = lines[lines.length - 1]
      .split(/\r?\n/)
      .map((line) => this.summarizeText(line))
      .filter(Boolean);
    return merged.length > 0 ? merged[merged.length - 1] : null;
  }

  private async hasRecentWorkspaceChanges(root: string, startedAt: number, depth = 4): Promise<boolean> {
    if (depth < 0) {
      return false;
    }

    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return false;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      const fullPath = `${root}/${entry.name}`;
      try {
        const details = await stat(fullPath);
        if (details.isFile() && details.mtimeMs >= startedAt) {
          return true;
        }
        if (details.isDirectory() && await this.hasRecentWorkspaceChanges(fullPath, startedAt, depth - 1)) {
          return true;
        }
      } catch {
        continue;
      }
    }

    return false;
  }

  /**
   * 函数作用：注册本地命令工作器配置。
   *
   * 参数说明：
   * - config：工作器注册信息，包含命令、环境变量和工作区配置。
   *
   * 返回值：
   * - Promise<WorkerRegistration>：返回已注册的工作器配置。
   */
  async register(config: WorkerRegistration): Promise<WorkerRegistration> {
    this.workerConfigs.set(config.worker_id, config);
    return config;
  }

  /**
   * 函数作用：启动一次本地命令执行。
   *
   * 参数说明：
   * - packet：调度器生成的工作器派发包。
   *
   * 返回值：
   * - Promise<void>：子进程启动完成后无返回数据。
   *
   * 注意事项：
   * - 本函数会创建子进程并记录 stdout、stderr、退出码和执行时间。
   */
  async startExecution(packet: WorkerDispatchPacket): Promise<void> {
    const worker = this.workerConfigs.get(packet.worker_id);
    if (!worker) {
      throw new Error(`Worker ${packet.worker_id} is not registered`);
    }

    const { command, args, env, cwd } = this.resolveCommand(worker, packet);
    await mkdir(cwd, { recursive: true });
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...env
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    const record: RuntimeRecord = {
      workerId: packet.worker_id,
      cwd,
      process: child,
      startedAt: Date.now(),
      stdout: [],
      stderr: [],
      stdoutLineBuffer: "",
      exitCode: null,
      finishedAt: null,
      errorMessage: null,
      resultCollectedAt: null
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      record.stdout.push(text);
      record.stdoutLineBuffer += text;
      let newlineIndex = record.stdoutLineBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = record.stdoutLineBuffer.slice(0, newlineIndex).replace(/\r$/, "");
        record.stdoutLineBuffer = record.stdoutLineBuffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          try {
            this.onStdoutLine(packet.execution_id, line);
          } catch (error) {
            record.stderr.push(`onStdoutLine error: ${(error as Error).message}`);
          }
        }
        newlineIndex = record.stdoutLineBuffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      record.stderr.push(chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      record.errorMessage = error.message;
      record.stderr.push(error.message);
      record.finishedAt = Date.now();
    });
    child.on("close", (exitCode) => {
      if (record.stdoutLineBuffer.length > 0) {
        const tail = record.stdoutLineBuffer.replace(/\r$/, "");
        record.stdoutLineBuffer = "";
        if (tail.length > 0) {
          try {
            this.onStdoutLine(packet.execution_id, tail);
          } catch (error) {
            record.stderr.push(`onStdoutLine error: ${(error as Error).message}`);
          }
        }
      }
      record.exitCode = exitCode;
      record.finishedAt = Date.now();
      try {
        this.onProcessClose(packet.execution_id, exitCode);
      } catch (error) {
        record.stderr.push(`onProcessClose error: ${(error as Error).message}`);
      }
    });

    this.runtimeByExecution.set(packet.execution_id, record);
  }

  /**
   * 函数作用：请求停止指定执行对应的本地进程。
   *
   * 参数说明：
   * - executionId：需要停止的执行 ID。
   *
   * 返回值：
   * - Promise<void>：发送终止信号后无返回数据。
   */
  async stopExecution(executionId: string): Promise<void> {
    const runtime = this.runtimeByExecution.get(executionId);
    runtime?.process.kill("SIGTERM");
  }

  /**
   * 函数作用：读取指定执行的当前心跳状态。
   *
   * 参数说明：
   * - executionId：需要查询的执行 ID。
   *
   * 返回值：
   * - WorkerHeartbeat | null：存在运行记录时返回心跳，否则返回 null。
   */
  async pollStatus(executionId: string): Promise<WorkerHeartbeat | null> {
    const runtime = this.runtimeByExecution.get(executionId);
    if (!runtime) {
      return null;
    }

    const status = runtime.finishedAt === null
      ? WorkerExecutionStatus.RUNNING
      : runtime.exitCode === 0
        ? WorkerExecutionStatus.IDLE
        : WorkerExecutionStatus.ERROR;

    return {
      schema_version: "v1",
      worker_id: runtime.workerId,
      execution_id: executionId,
      status,
      progress_note: this.getLastLine(runtime.stdout) || this.getLastLine(runtime.stderr),
      source: runtime.stdout.length > 0 || runtime.stderr.length > 0 ? "event_stream" : "status_poll",
      emitted_at: nowIso(),
      adapter_meta: {
        runtime_ms: Date.now() - runtime.startedAt
      }
    };
  }

  /**
   * 函数作用：收集已结束执行的工作器结果。
   *
   * 参数说明：
   * - executionId：需要收集结果的执行 ID。
   *
   * 返回值：
   * - WorkerResult | null：进程已结束时返回标准结果，否则返回 null。
   *
   * 注意事项：
   * - 本函数会根据退出码、输出内容和工作区变更生成产物与阻塞原因。
   */
  async collectResult(executionId: string): Promise<WorkerResult | null> {
    const runtime = this.runtimeByExecution.get(executionId);
    if (!runtime || runtime.finishedAt === null) {
      return null;
    }
    if (runtime.resultCollectedAt !== null) {
      return null;
    }

    runtime.resultCollectedAt = Date.now();
    const producedArtifacts = runtime.exitCode === 0 && await this.hasRecentWorkspaceChanges(runtime.cwd, runtime.startedAt)
      ? [
          {
            artifact_id: createId("artifact"),
            artifact_type: "file_bundle" as const,
            backend: "filesystem" as const,
            uri: runtime.cwd,
            metadata: {
              execution_id: executionId
            },
            created_at: nowIso()
          }
        ]
      : [];

    return {
      schema_version: "v1",
      execution_id: executionId,
      worker_id: runtime.workerId,
      worker_status: this.mapExitCode(runtime.exitCode, runtime.stdout.join(""), runtime.stderr.join("")),
      claimed_outcome: this.getLastLine(runtime.stdout),
      compressed_history: this.summarizeText([...runtime.stdout, ...runtime.stderr].join(""), 5000),
      produced_artifacts: producedArtifacts,
      blocker_reason: runtime.exitCode === 0
        ? null
        : {
            code: "PROCESS_EXIT",
            message: runtime.errorMessage
              || runtime.stderr.join("").slice(-1000)
              || `Process exited with code ${runtime.exitCode}`
          },
      suggested_next_step: runtime.exitCode === 0 ? "Verify produced artifacts" : "Inspect stderr and retry or request human decision",
      budget_used: {
        duration_ms: runtime.finishedAt - runtime.startedAt
      },
      adapter_meta: {
        exit_code: runtime.exitCode
      },
      returned_at: nowIso()
    };
  }

  /**
   * 函数作用：检查本地工作器是否已注册且具备基础配置。
   *
   * 参数说明：
   * - workerId：工作器唯一 ID。
   *
   * 返回值：
   * - Promise<{ ok: boolean; message: string }>：返回健康状态和说明信息。
   */
  async healthCheck(workerId: string): Promise<{ ok: boolean; message: string }> {
    const worker = this.workerConfigs.get(workerId);
    if (!worker) {
      return { ok: false, message: "Worker not registered" };
    }
    return { ok: true, message: `Worker ${worker.name} configured` };
  }

  /**
   * 函数作用：将子进程退出信息映射为工作器结果状态。
   *
   * 参数说明：
   * - exitCode：子进程退出码。
   * - stdout：标准输出内容。
   * - stderr：标准错误内容。
   *
   * 返回值：
   * - WorkerResultStatus：调度系统可识别的执行结果状态。
   */
  protected mapExitCode(exitCode: number | null, stdout: string, stderr: string): WorkerResultStatus {
    if (exitCode === 0 && stdout.trim().length > 0) {
      return WorkerResultStatus.DONE;
    }
    if (exitCode === 0) {
      return WorkerResultStatus.PARTIAL;
    }
    const merged = `${stdout}\n${stderr}`.toLowerCase();
    if (merged.includes("permission") || merged.includes("blocked")) {
      return WorkerResultStatus.BLOCKED;
    }
    if (merged.includes("need") && merged.includes("info")) {
      return WorkerResultStatus.NEED_HELP;
    }
    return WorkerResultStatus.FAILED;
  }

  protected abstract resolveCommand(
    worker: WorkerRegistration,
    packet: WorkerDispatchPacket
  ): {
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
  };
}
