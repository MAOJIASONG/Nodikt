import path from "path";

import { ExecutionState, nowIso, WorkerRegistration, WorkerRegistryStatus } from "./domain/index.js";
import { WorkerAdapter } from "./worker/adapters/index.js";
import { createApp } from "./app.js";

// 注意：环境变量用 `||` 而不是 `??` —— 用户的 .env 经常把变量留空字符串（如 `NODIKT_WORKSPACE_ROOT=`），
// `??` 不会回落默认值（空串不是 nullish），会导致 zod 校验 workspace_root 失败。
const OPEN_CODE_INSTALL_ROOT =
  process.env.OPENCODE_INSTALL_ROOT
  || path.resolve(process.cwd(), "../opencode");
const OPEN_CODE_RUNTIME_HOME =
  process.env.OPENCODE_RUNTIME_HOME
  || path.resolve(process.cwd(), ".opencode-runtime");
const CLAUDE_CODE_INSTALL_ROOT =
  process.env.CLAUDE_CODE_INSTALL_ROOT ?? "";
const CLAUDE_CODE_RUNTIME_HOME =
  process.env.CLAUDE_CODE_RUNTIME_HOME
  || path.resolve(process.cwd(), ".claude-code-runtime");
const CLAUDE_CODE_PERMISSION_MODE =
  process.env.CLAUDE_CODE_PERMISSION_MODE
  || "bypassPermissions";
/**
 * Claude Code 默认允许的工具集。
 *
 * 为什么需要默认：permission_mode=acceptEdits 时只有文件编辑工具自动放行，
 * 其他工具（Bash / WebFetch / WebSearch / Glob / Grep / Task）需要 --allowedTools
 * 显式授权，否则在 headless（无人审批）模式下会被当成"用户拒绝"。
 *
 * 用户可以通过 .env 的 CLAUDE_CODE_ALLOWED_TOOLS 覆盖（逗号分隔的工具名）。
 */
const DEFAULT_CLAUDE_CODE_ALLOWED_TOOLS =
  "Read,Write,Edit,MultiEdit,NotebookEdit,Bash,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite";

const CLAUDE_CODE_ALLOWED_TOOLS =
  (process.env.CLAUDE_CODE_ALLOWED_TOOLS && process.env.CLAUDE_CODE_ALLOWED_TOOLS.trim().length > 0)
    ? process.env.CLAUDE_CODE_ALLOWED_TOOLS
    : DEFAULT_CLAUDE_CODE_ALLOWED_TOOLS;
const CLAUDE_CODE_DISALLOWED_TOOLS =
  process.env.CLAUDE_CODE_DISALLOWED_TOOLS ?? "";

// Codex CLI 安装根 + 运行时 HOME（与 claude/opencode 同款约定）
const CODEX_INSTALL_ROOT =
  process.env.CODEX_INSTALL_ROOT ?? "";
const CODEX_RUNTIME_HOME =
  process.env.CODEX_RUNTIME_HOME
  || path.resolve(process.cwd(), ".codex-runtime");

const DEFAULT_WORKSPACE_ROOT =
  process.env.NODIKT_WORKSPACE_ROOT
  || path.resolve(process.cwd(), "workspace");

type AppContext = Awaited<ReturnType<typeof createApp>>;

function pickAdapterByType(
  adapters: AppContext["adapters"],
  adapterType: string
): WorkerAdapter | null {
  switch (adapterType) {
    case "opencode":
      return adapters.opencodeAdapter;
    case "claude_code":
      return adapters.claudeCodeAdapter;
    case "codex":
      return adapters.codexAdapter;
    default:
      return null;
  }
}

function buildOpencodeEnv(): Record<string, string> {
  return {
    HOME: OPEN_CODE_RUNTIME_HOME,
    PATH: `${path.join(OPEN_CODE_INSTALL_ROOT, "bin")}:${process.env.PATH ?? ""}`
  };
}

function buildClaudeCodeEnv(): Record<string, string> {
  const env: Record<string, string> = {
    HOME: CLAUDE_CODE_RUNTIME_HOME,
    PATH: CLAUDE_CODE_INSTALL_ROOT.length > 0
      ? `${path.join(CLAUDE_CODE_INSTALL_ROOT, "bin")}:${process.env.PATH ?? ""}`
      : process.env.PATH ?? "",
    CLAUDE_CODE_PERMISSION_MODE
  };
  if (CLAUDE_CODE_ALLOWED_TOOLS.length > 0) {
    env.CLAUDE_CODE_ALLOWED_TOOLS = CLAUDE_CODE_ALLOWED_TOOLS;
  }
  if (CLAUDE_CODE_DISALLOWED_TOOLS.length > 0) {
    env.CLAUDE_CODE_DISALLOWED_TOOLS = CLAUDE_CODE_DISALLOWED_TOOLS;
  }
  return env;
}

function buildDefaultOpencodeWorker(timestamp: string): WorkerRegistration {
  return {
    worker_id: "worker_opencode_local",
    name: "OpenCode Local",
    adapter_type: "opencode",
    runtime_type: "local_command",
    status: WorkerRegistryStatus.IDLE,
    max_concurrency: 3,
    capabilities: ["code_generation", "file_edit", "command_execution"],
    available_skills: [],
    install_policy: "allowed_with_review",
    config: {
      workspace_root: DEFAULT_WORKSPACE_ROOT,
      command: "bash",
      args: [path.join(OPEN_CODE_INSTALL_ROOT, "opencode_run.sh")],
      env: buildOpencodeEnv()
    },
    current_execution_ids: [],
    last_seen_at: null,
    last_error: null,
    is_enabled: true,
    created_at: timestamp,
    updated_at: timestamp
  };
}

function buildCodexEnv(): Record<string, string> {
  return {
    HOME: CODEX_RUNTIME_HOME,
    PATH: CODEX_INSTALL_ROOT.length > 0
      ? `${path.join(CODEX_INSTALL_ROOT, "bin")}:${process.env.PATH ?? ""}`
      : process.env.PATH ?? ""
  };
}

function buildDefaultCodexWorker(timestamp: string): WorkerRegistration {
  return {
    worker_id: "worker_codex_local",
    name: "Codex Local",
    adapter_type: "codex",
    runtime_type: "local_command",
    status: WorkerRegistryStatus.IDLE,
    max_concurrency: 3,
    capabilities: ["code_generation", "file_edit", "command_execution"],
    available_skills: [],
    install_policy: "allowed_with_review",
    config: {
      workspace_root: DEFAULT_WORKSPACE_ROOT,
      command: CODEX_INSTALL_ROOT.length > 0
        ? path.join(CODEX_INSTALL_ROOT, "bin", "codex")
        : "codex",
      args: [],
      env: buildCodexEnv()
    },
    current_execution_ids: [],
    last_seen_at: null,
    last_error: null,
    is_enabled: true,
    created_at: timestamp,
    updated_at: timestamp
  };
}

function buildDefaultClaudeCodeWorker(timestamp: string): WorkerRegistration {
  return {
    worker_id: "worker_claude_code_local",
    name: "Claude Code Local",
    adapter_type: "claude_code",
    runtime_type: "local_command",
    status: WorkerRegistryStatus.IDLE,
    max_concurrency: 4,
    capabilities: ["code_generation", "file_edit", "command_execution"],
    available_skills: [],
    install_policy: "allowed_with_review",
    config: {
      workspace_root: DEFAULT_WORKSPACE_ROOT,
      command: CLAUDE_CODE_INSTALL_ROOT.length > 0
        ? path.join(CLAUDE_CODE_INSTALL_ROOT, "bin", "claude")
        : "claude",
      args: [],
      env: buildClaudeCodeEnv()
    },
    current_execution_ids: [],
    last_seen_at: null,
    last_error: null,
    is_enabled: true,
    created_at: timestamp,
    updated_at: timestamp
  };
}

function normalizeWorkerConfig(worker: WorkerRegistration): WorkerRegistration {
  if (worker.adapter_type === "claude_code") {
    return {
      ...worker,
      config: {
        ...worker.config,
        workspace_root: DEFAULT_WORKSPACE_ROOT,
        env: {
          ...buildClaudeCodeEnv(),
          ...(worker.config.env ?? {})
        }
      }
    };
  }
  if (worker.adapter_type === "codex") {
    return {
      ...worker,
      config: {
        ...worker.config,
        workspace_root: DEFAULT_WORKSPACE_ROOT,
        env: {
          ...buildCodexEnv(),
          ...(worker.config.env ?? {})
        }
      }
    };
  }
  return {
    ...worker,
    config: {
      ...worker.config,
      workspace_root: DEFAULT_WORKSPACE_ROOT,
      env: {
        ...(worker.config.env ?? {}),
        ...buildOpencodeEnv()
      }
    }
  };
}

async function registerWorker(
  appContext: AppContext,
  worker: WorkerRegistration,
  adapter: WorkerAdapter
): Promise<void> {
  await appContext.repositories.workers.upsert(worker);
  appContext.adapterRegistry.registerAdapter(worker.worker_id, worker, adapter);
  await adapter.register(worker);
}

async function ensureDefaultWorkers(appContext: AppContext): Promise<void> {
  const { repositories, adapters } = appContext;
  const settings = await repositories.loadSettings();
  if (settings.workspace_root !== DEFAULT_WORKSPACE_ROOT) {
    await repositories.settings.save({
      ...settings,
      workspace_root: DEFAULT_WORKSPACE_ROOT
    });
  }

  // Legacy cleanup: remove deprecated worker rows before reconciling.
  // - worker_opencode_local: opencode CLI 在本机大概率没装；保持下线。要恢复就把它从下面的
  //   RETIRED_* 列表里去掉 + 确认 OPENCODE_INSTALL_ROOT 指到真实安装。
  // - worker_codex_local: codex CLI 暂时未部署；改用"前端注册演示"模式 ——
  //   用户在 Workers 页面点 Add Worker 选 codex 即可，POST /workers/register 路由会按
  //   adapter_type 绑定 codexAdapter 实例，worker 会以 IDLE 状态在前端绿灯显示。
  await repositories.workers.delete("worker_opencode_local");
  await repositories.workers.delete("worker_codex_local");

  const RETIRED_WORKER_IDS = new Set(["worker_opencode_local", "worker_codex_local"]);
  const RETIRED_ADAPTER_TYPES = new Set(["opencode", "codex"]);

  const executions = await repositories.executions.list();
  const existing = (await repositories.workers.list()).filter(
    (worker) => !RETIRED_WORKER_IDS.has(worker.worker_id) && !RETIRED_ADAPTER_TYPES.has(worker.adapter_type)
  );

  const seenAdapterTypes = new Set<string>();
  for (const worker of existing) {
    const adapter = pickAdapterByType(adapters, worker.adapter_type);
    if (!adapter) {
      continue;
    }
    const activeExecutionIds = worker.current_execution_ids.filter((executionId) => {
      const execution = executions.find((item) => item.execution_id === executionId);
      return execution?.state === ExecutionState.RUNNING
        || execution?.state === ExecutionState.QUEUED
        || execution?.state === ExecutionState.VERIFYING;
    });
    const normalized = normalizeWorkerConfig({
      ...worker,
      status: activeExecutionIds.length > 0 ? WorkerRegistryStatus.BUSY : WorkerRegistryStatus.IDLE,
      max_concurrency: Math.max(worker.max_concurrency, worker.adapter_type === "claude_code" ? 4 : 3),
      current_execution_ids: activeExecutionIds,
      updated_at: nowIso()
    });
    await registerWorker(appContext, normalized, adapter);
    seenAdapterTypes.add(worker.adapter_type);
  }

  const timestamp = nowIso();
  if (!seenAdapterTypes.has("claude_code")) {
    await registerWorker(appContext, buildDefaultClaudeCodeWorker(timestamp), adapters.claudeCodeAdapter);
  }
  // codex 暂时不种默认 worker —— 留给用户在 UI 上演示 "Add Worker" 动作（POST /workers/register 路径会真正
  // 绑定 codexAdapter 给新 worker，绿灯亮起）。要恢复默认，把下方代码取消注释即可。
  // if (!seenAdapterTypes.has("codex")) {
  //   await registerWorker(appContext, buildDefaultCodexWorker(timestamp), adapters.codexAdapter);
  // }
}

async function main(): Promise<void> {
  const appContext = await createApp();
  await ensureDefaultWorkers(appContext);
  const timer = appContext.opsMonitor.start(appContext.eventBus);
  const port = Number(process.env.SERVER_PORT ?? 3001);

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
