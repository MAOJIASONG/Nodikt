import path from "path";

import { ExecutionState, nowIso, WorkerRegistryStatus } from "./domain/index.js";
import { createApp } from "./app.js";

const OPEN_CODE_INSTALL_ROOT =
  process.env.OPENCODE_INSTALL_ROOT ??
  path.resolve(process.cwd(), "../opencode");
const OPEN_CODE_RUNTIME_HOME =
  process.env.OPENCODE_RUNTIME_HOME ??
  path.resolve(process.cwd(), ".opencode-runtime");
const DEFAULT_WORKSPACE_ROOT =
  process.env.NODIKT_WORKSPACE_ROOT ??
  path.resolve(process.cwd(), "workspace");

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
            HOME: OPEN_CODE_RUNTIME_HOME,
            PATH: `${path.join(OPEN_CODE_INSTALL_ROOT, "bin")}:${process.env.PATH ?? ""}`
          }
        },
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
      command: "bash",
      args: [path.join(OPEN_CODE_INSTALL_ROOT, "opencode_run.sh")],
      env: {
        HOME: OPEN_CODE_RUNTIME_HOME,
        PATH: `${path.join(OPEN_CODE_INSTALL_ROOT, "bin")}:${process.env.PATH ?? ""}`
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
