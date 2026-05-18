/**
 * 文件名称：service.ts
 * 文件作用：任务派发服务，负责把子目标和执行上下文组装成工作器派发包。
 *
 * 主要职责：
 * 1. 根据需求、子目标、执行和设置生成 WorkerDispatchPacket。
 * 2. 组织工作器上下文、预算、权限和回复协议。
 * 3. 为不同工作器适配器提供统一任务输入。
 *
 * 依赖模块：
 * - domain：派发包、需求、子目标、执行、工作器和设置类型。
 *
 * 注意事项：
 * - 派发包是调度器与工作器之间的重要契约，字段变更需同步适配器和测试。
 * - 上下文内容应足够完成任务，但避免泄露不必要的数据。
 */
import {
  Demand,
  Execution,
  ExecutionState,
  Settings,
  SubgoalContract,
  WorkerDispatchPacket,
  WorkerRegistration,
  nowIso
} from "../../../domain/index.js";
import type { DispatchMemorySnapshot } from "../../store/memory_manager/service.js";

/**
 * 函数作用：合并系统级和需求级的额外可写路径，返回去重后的绝对路径列表。
 * 一旦此函数返回的路径列表非空，dispatcher 会在 packet 的 environment_notes 中
 * 注入 workspace_allowed_paths=...，adapter prompt 会转成软约束提示。
 */
export function collectWorkspaceGrants(settings: Settings, demand: Demand): string[] {
  const settingsGrants = (settings.workspace_grants ?? [])
    .map((g) => g.path)
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0);
  const demandGrantsRaw = demand.metadata?.workspace_grants;
  const demandGrants = Array.isArray(demandGrantsRaw)
    ? demandGrantsRaw
        .filter((g: unknown): g is { path: string } =>
          Boolean(g)
          && typeof g === "object"
          && typeof (g as Record<string, unknown>).path === "string"
          && ((g as Record<string, unknown>).path as string).trim().length > 0
        )
        .map((g) => g.path)
    : [];
  return Array.from(new Set([...settingsGrants, ...demandGrants]));
}

function readExecutionGuidance(demand: Demand, subgoalId: string): string[] {
  const raw = demand.metadata?.execution_guidance;
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    .filter((item) => item.subgoal_id === undefined || item.subgoal_id === null || item.subgoal_id === subgoalId)
    .map((item) => typeof item.note === "string" ? item.note.trim() : "")
    .filter(Boolean)
    .slice(-4);
}

export class DispatcherService {
  /**
   * 函数作用：从候选工作器中选择一个可承接子目标的工作器。
   *
   * 参数说明：
   * - workers：候选工作器列表。
   * - subgoal：待执行的子目标契约。
   *
   * 返回值：
   * - WorkerRegistration | undefined：找到可用工作器时返回该工作器，否则返回 undefined。
   */
  selectWorker(workers: WorkerRegistration[], subgoal: SubgoalContract): WorkerRegistration | undefined {
    // 先 filter 出所有可用 worker，再按"当前负载最低优先"挑一个 —— 让 frontier 里多个独立 subgoal
    // 派给不同 worker 或者同 worker 多 slot 平均分布，避免某个 worker 排队、其他 worker 闲着。
    const candidates = workers.filter((worker) => (
      worker.is_enabled
      && worker.capabilities.some((capability) => ["code_generation", "file_edit", "command_execution"].includes(capability))
      && worker.current_execution_ids.length < worker.max_concurrency
      && subgoal.constraints.every(() => true)
    ));
    if (candidates.length === 0) {
      return undefined;
    }
    candidates.sort((a, b) => {
      const loadDiff = a.current_execution_ids.length - b.current_execution_ids.length;
      if (loadDiff !== 0) return loadDiff;
      const capDiff = b.max_concurrency - a.max_concurrency;
      if (capDiff !== 0) return capDiff;
      return a.worker_id.localeCompare(b.worker_id);
    });
    return candidates[0];
  }

  /**
   * 函数作用：为子目标创建一条排队中的执行记录。
   *
   * 参数说明：
   * - input.demand：所属需求。
   * - input.subgoal：需要执行的子目标。
   * - input.worker：承接执行的工作器。
   * - input.attempt：可选执行尝试次数，默认从 1 开始。
   *
   * 返回值：
   * - Execution：初始化后的执行实体。
   */
  buildExecution(input: {
    demand: Demand;
    subgoal: SubgoalContract;
    worker: WorkerRegistration;
    attempt?: number;
  }): Execution {
    const timestamp = nowIso();
    return {
      execution_id: `exec_${Math.random().toString(36).slice(2, 10)}`,
      demand_id: input.demand.demand_id,
      subgoal_id: input.subgoal.subgoal_id,
      worker_id: input.worker.worker_id,
      state: ExecutionState.QUEUED,
      attempt: input.attempt ?? 1,
      started_at: null,
      completed_at: null,
      last_heartbeat_at: null,
      latest_worker_status: null,
      result_status: null,
      claimed_outcome: null,
      compressed_history: "",
      artifacts: [],
      adapter_meta: {},
      created_at: timestamp,
      updated_at: timestamp
    };
  }

  /**
   * 函数作用：构造发送给工作器适配器的派发包。
   *
   * 参数说明：
   * - input：包含需求、子目标、执行、工作器和运行时预算配置。
   *
   * 返回值：
   * - WorkerDispatchPacket：工作器可消费的标准任务包。
   *
   * 注意事项：
   * - 派发包字段是调度器和工作器之间的协议，修改时需同步适配器。
   */
  buildPacket(input: {
    demand: Demand;
    subgoal: SubgoalContract;
    execution: Execution;
    worker: WorkerRegistration;
    workspaceRoot: string;
    heartbeatSeconds: number;
    timeoutSeconds: number;
    memorySnapshot?: DispatchMemorySnapshot;
    claudeResumeSessionId?: string | null;
    /** 用户级永久授权 + demand 级临时授权的额外可写路径合集（绝对路径） */
    workspaceGrants?: string[];
  }): WorkerDispatchPacket {
    const executionGuidance = readExecutionGuidance(input.demand, input.subgoal.subgoal_id);
    const memorySnapshot = input.memorySnapshot;

    const missionStateSummary = memorySnapshot?.missionStateSummary
      ? `Demand phase: ${input.demand.current_phase} | Memory: ${memorySnapshot.missionStateSummary}`
      : `Demand phase: ${input.demand.current_phase}`;

    const historySegments: string[] = [];
    if (executionGuidance.length > 0) {
      historySegments.push(executionGuidance.join("\n\n"));
    }
    if (memorySnapshot && memorySnapshot.recentTraces.length > 0) {
      historySegments.push(
        ["Recent execution traces:", ...memorySnapshot.recentTraces.map((trace) => `- ${trace}`)].join("\n")
      );
    }
    const relevantHistory = historySegments.length > 0
      ? historySegments.join("\n\n")
      : "v1 minimal history";

    const sharedHints: string[] = [
      "Follow the subgoal only",
      "Do not mutate objective",
      ...executionGuidance.map((note) => `Retry guidance: ${note}`)
    ];
    if (memorySnapshot) {
      for (const lesson of memorySnapshot.lessons) {
        sharedHints.push(`Lesson from past attempts: ${lesson}`);
      }
    }

    // 如果 demand 级 workspace_grants 非空（用户在 PATH_GRANT_REQUIRED 决策中显式批准了一个目录），
    // 用它当 effective workspace root（adapter 真正的 cwd），让 worker 直接在用户期望的目录里干活。
    // settings.workspace_root + 其他 grants 仍会进 workspace_allowed_paths，作为"附加可写区"提示。
    const demandGrantsRaw = input.demand.metadata?.workspace_grants;
    const demandGrantPaths: string[] = Array.isArray(demandGrantsRaw)
      ? demandGrantsRaw
          .filter((g: unknown): g is { path: string } =>
            Boolean(g)
            && typeof g === "object"
            && typeof (g as Record<string, unknown>).path === "string"
            && ((g as Record<string, unknown>).path as string).trim().length > 0
          )
          .map((g) => g.path)
      : [];
    const effectiveWorkspaceRoot = demandGrantPaths[0] ?? input.workspaceRoot;

    const environmentNotes: string[] = [`workspace_root=${effectiveWorkspaceRoot}`];
    const allowedPaths = Array.from(new Set([
      effectiveWorkspaceRoot,
      input.workspaceRoot,
      ...((input.workspaceGrants ?? []).filter((p) => typeof p === "string" && p.trim().length > 0))
    ]));
    if (allowedPaths.length > 1) {
      environmentNotes.push(`workspace_allowed_paths=${allowedPaths.join("|")}`);
    }
    if (input.worker.adapter_type === "claude_code" && input.claudeResumeSessionId) {
      environmentNotes.push(`claude_session_resume=${input.claudeResumeSessionId}`);
    }

    // Clarification 阶段就派 recon worker 时 demand.operational_objective 还是 null —— 给一个最小占位
    const fallbackObjectiveText = input.demand.clarified_demand
      ?? input.demand.initial_input
      ?? input.subgoal.objective;
    const effectiveOperationalObjective = input.demand.operational_objective ?? {
      objective: fallbackObjectiveText,
      acceptance_criteria: [],
      constraints: [],
      non_goals: [],
      termination_conditions: []
    };

    return {
      schema_version: "v1",
      execution_id: input.execution.execution_id,
      demand_id: input.demand.demand_id,
      subgoal_id: input.subgoal.subgoal_id,
      worker_id: input.worker.worker_id,
      clarified_demand: input.demand.clarified_demand ?? input.demand.initial_input,
      operational_objective: effectiveOperationalObjective,
      subgoal_contract: input.subgoal,
      context_slice: {
        mission_state_summary: missionStateSummary,
        relevant_history: relevantHistory,
        relevant_artifacts: [],
        shared_hints: sharedHints,
        environment_notes: environmentNotes,
        skills: []
      },
      permissions: {
        can_modify_files: true,
        can_run_commands: true,
        can_install_dependencies: false,
        can_open_pr: false
      },
      reply_protocol: {
        result_schema_version: "v1",
        heartbeat_interval_seconds: input.heartbeatSeconds,
        execution_timeout_seconds: input.timeoutSeconds
      },
      created_at: nowIso()
    };
  }
}
