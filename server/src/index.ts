/**
 * 文件名称：index.ts
 * 文件作用：后端进程启动入口，负责创建应用、初始化默认工作器并监听端口。
 *
 * 主要职责：
 * 1. 调用 createApp 创建完整服务上下文。
 * 2. 初始化本地 OpenCode 工作器配置和运行环境。
 * 3. 启动运维监控定时器与 HTTP 服务监听。
 * 4. 处理进程退出信号，完成基础资源清理。
 *
 * 依赖模块：
 * - app：应用上下文工厂。
 * - domain：执行状态、工作器状态和时间工具。
 * - worker/adapters/opencodeRuntime：OpenCode 运行环境解析。
 *
 * 注意事项：
 * - 本文件是进程级入口，避免放入可复用业务逻辑。
 * - 修改默认工作区或工作器策略时，需要同步评估数据迁移影响。
 */
import path from "path";

import { ExecutionState, nowIso, WorkerRegistryStatus } from "./domain/index.js";
import { createApp } from "./app.js";
import { getOpenCodeRuntimeEnv } from "./worker/adapters/opencodeRuntime.js";

const SERVER_ROOT = path.resolve(__dirname, "..");
const DEFAULT_WORKSPACE_ROOT =
  process.env.NODIKT_WORKSPACE_ROOT ??
  path.resolve(SERVER_ROOT, "workspace");

/**
 * 函数作用：确保系统启动时存在可用的默认本地工作器。
 *
 * 参数说明：
 * - appContext：createApp 返回的应用上下文，包含仓储、适配器注册表和适配器实例。
 *
 * 返回值：
 * - Promise<void>：初始化完成后无返回数据。
 *
 * 注意事项：
 * - 本函数会写入 settings 和 workers 仓储，并把工作器注册到内存适配器注册表。
 */
async function ensureDefaultWorkers(appContext: Awaited<ReturnType<typeof createApp>>): Promise<void> {
  const { repositories, adapterRegistry, adapters } = appContext;
  const settings = await repositories.loadSettings();
  if (settings.workspace_root !== DEFAULT_WORKSPACE_ROOT) {
    await repositories.settings.save({
      ...settings,
      workspace_root: DEFAULT_WORKSPACE_ROOT
    });
  }
  const executions = await repositories.executions.list();
  const workers = (await repositories.workers.list()).filter((worker) => worker.worker_id !== "worker_codex_local");
  await repositories.workers.delete("worker_codex_local");
  if (workers.length > 0) {
    for (const worker of workers) {
      const activeExecutionIds = worker.current_execution_ids.filter((executionId) => {
        const execution = executions.find((item) => item.execution_id === executionId);
        return execution?.state === ExecutionState.RUNNING || execution?.state === ExecutionState.QUEUED || execution?.state === ExecutionState.VERIFYING;
      });
      const normalizedWorker = {
        ...worker,
        status: activeExecutionIds.length > 0 ? WorkerRegistryStatus.BUSY : WorkerRegistryStatus.IDLE,
        max_concurrency: Math.max(worker.max_concurrency, 3),
        current_execution_ids: activeExecutionIds,
        config: {
          ...worker.config,
          workspace_root: DEFAULT_WORKSPACE_ROOT,
          env: {
            ...(worker.config.env ?? {}),
            ...getOpenCodeRuntimeEnv()
          }
        },
        last_error: null,
        updated_at: nowIso()
      };
      await repositories.workers.upsert(normalizedWorker);
      adapterRegistry.registerAdapter(normalizedWorker.worker_id, normalizedWorker, adapters.opencodeAdapter);
      await adapters.opencodeAdapter.register(normalizedWorker);
    }
    return;
  }

  const timestamp = nowIso();
  const opencodeWorker = {
    worker_id: "worker_opencode_local",
    name: "OpenCode Local",
    adapter_type: "opencode" as const,
    runtime_type: "local_command" as const,
    status: WorkerRegistryStatus.IDLE,
    max_concurrency: 3,
    capabilities: ["code_generation", "file_edit", "command_execution"],
    available_skills: [],
    install_policy: "allowed_with_review" as const,
    config: {
      workspace_root: DEFAULT_WORKSPACE_ROOT,
      env: {
        ...getOpenCodeRuntimeEnv()
      }
    },
    current_execution_ids: [],
    last_seen_at: null,
    last_error: null,
    is_enabled: true,
    created_at: timestamp,
    updated_at: timestamp
  };

  await repositories.workers.upsert(opencodeWorker);
  adapterRegistry.registerAdapter(opencodeWorker.worker_id, opencodeWorker, adapters.opencodeAdapter);
  await adapters.opencodeAdapter.register(opencodeWorker);
}

/**
 * 函数作用：启动后端进程并监听 HTTP 端口。
 *
 * 参数说明：
 * - 无。
 *
 * 返回值：
 * - Promise<void>：服务启动流程完成后由 Node 事件循环保持运行。
 *
 * 注意事项：
 * - 本函数会启动运维监控定时器，并注册 SIGINT、SIGTERM 退出清理逻辑。
 */
async function main(): Promise<void> {
  const appContext = await createApp();
  await ensureDefaultWorkers(appContext);
  const timer = appContext.opsMonitor.start(appContext.eventBus);
  const port = Number(process.env.PORT ?? 3001);

  appContext.server.listen(port, () => {
    console.log(`Nodikt server listening on http://localhost:${port}`);
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      clearInterval(timer);
      appContext.server.close();
      process.exit(0);
    });
  }
}

void main();
