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
  SubgoalContract,
  WorkerDispatchPacket,
  WorkerRegistration,
  nowIso
} from "../../../domain/index.js";

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
    return workers.find((worker) => {
      return worker.is_enabled
        && worker.capabilities.some((capability) => ["code_generation", "file_edit", "command_execution"].includes(capability))
        && worker.current_execution_ids.length < worker.max_concurrency
        && subgoal.constraints.every(() => true);
    });
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
  }): WorkerDispatchPacket {
    const executionGuidance = readExecutionGuidance(input.demand, input.subgoal.subgoal_id);

    return {
      schema_version: "v1",
      execution_id: input.execution.execution_id,
      demand_id: input.demand.demand_id,
      subgoal_id: input.subgoal.subgoal_id,
      worker_id: input.worker.worker_id,
      clarified_demand: input.demand.clarified_demand ?? input.demand.initial_input,
      operational_objective: input.demand.operational_objective!,
      subgoal_contract: input.subgoal,
      context_slice: {
        mission_state_summary: `Demand phase: ${input.demand.current_phase}`,
        relevant_history: executionGuidance.length > 0
          ? executionGuidance.join("\n\n")
          : "v1 minimal history",
        relevant_artifacts: [],
        shared_hints: [
          "Follow the subgoal only",
          "Do not mutate objective",
          ...executionGuidance.map((note) => `Retry guidance: ${note}`)
        ],
        environment_notes: [`workspace_root=${input.workspaceRoot}`],
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
