import {
  Demand,
  Execution,
  ExecutionState,
  SubgoalContract,
  WorkerDispatchPacket,
  WorkerRegistration,
  nowIso
} from "../domain/index.js";

export class DispatcherService {
  selectWorker(workers: WorkerRegistration[], subgoal: SubgoalContract): WorkerRegistration | undefined {
    return workers.find((worker) => {
      return worker.is_enabled
        && worker.capabilities.some((capability) => ["code_generation", "file_edit", "command_execution"].includes(capability))
        && worker.current_execution_ids.length < worker.max_concurrency
        && subgoal.constraints.every(() => true);
    });
  }

  buildExecution(input: {
    demand: Demand;
    subgoal: SubgoalContract;
    worker: WorkerRegistration;
  }): Execution {
    const timestamp = nowIso();
    return {
      execution_id: `exec_${Math.random().toString(36).slice(2, 10)}`,
      demand_id: input.demand.demand_id,
      subgoal_id: input.subgoal.subgoal_id,
      worker_id: input.worker.worker_id,
      state: ExecutionState.QUEUED,
      attempt: 1,
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

  buildPacket(input: {
    demand: Demand;
    subgoal: SubgoalContract;
    execution: Execution;
    worker: WorkerRegistration;
    workspaceRoot: string;
    heartbeatSeconds: number;
    timeoutSeconds: number;
  }): WorkerDispatchPacket {
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
        relevant_history: "v1 minimal history",
        relevant_artifacts: [],
        shared_hints: ["Follow the subgoal only", "Do not mutate objective"],
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
