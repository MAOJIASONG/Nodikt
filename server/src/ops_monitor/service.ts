import { createEvent, EventType, ExecutionState } from "../domain/index.js";
import { EventBus } from "../event_bus/eventBus.js";
import { createWorkerFailureResult } from "../handlers/executionRuntime.js";
import { RepositoryBundle } from "../repositories/index.js";
import { AdapterRegistry } from "../worker_adapters/registry.js";

export class OpsMonitor {
  constructor(
    private readonly repositories: RepositoryBundle,
    private readonly adapterRegistry: AdapterRegistry
  ) {}

  start(eventBus: EventBus): NodeJS.Timeout {
    return setInterval(async () => {
      const settings = await this.repositories.loadSettings();
      const executions = await this.repositories.executions.list();
      for (const execution of executions.filter((item) => item.state === ExecutionState.RUNNING || item.state === ExecutionState.QUEUED)) {
        const adapter = this.adapterRegistry.getExecutionAdapter(execution.execution_id);
        if (!adapter) {
          continue;
        }

        try {
          const heartbeat = await adapter.pollStatus(execution.execution_id);
          if (heartbeat) {
            await eventBus.publish(
              createEvent(
                EventType.WORKER_HEARTBEAT_RECEIVED,
                { heartbeat },
                {
                  demand_id: execution.demand_id,
                  subgoal_id: execution.subgoal_id,
                  execution_id: execution.execution_id,
                  worker_id: execution.worker_id
                }
              )
            );
          }

          const result = await adapter.collectResult(execution.execution_id);
          if (result) {
            await eventBus.publish(
              createEvent(
                EventType.WORKER_RESULT_RECEIVED,
                { worker_result: result },
                {
                  demand_id: execution.demand_id,
                  subgoal_id: execution.subgoal_id,
                  execution_id: execution.execution_id,
                  worker_id: execution.worker_id
                }
              )
            );
          } else if (
            execution.started_at
            && Date.now() - new Date(execution.started_at).getTime()
              > settings.runtime.execution_timeout_seconds * 1000
          ) {
            await eventBus.publish(
              createEvent(
                EventType.OPS_ALERT,
                {
                  code: "EXECUTION_TIMEOUT",
                  message: `Execution ${execution.execution_id} exceeded timeout`,
                  severity: "error"
                },
                {
                  demand_id: execution.demand_id,
                  subgoal_id: execution.subgoal_id,
                  execution_id: execution.execution_id,
                  worker_id: execution.worker_id
                }
              )
            );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await eventBus.publish(
            createEvent(
              EventType.WORKER_RESULT_RECEIVED,
              {
                worker_result: createWorkerFailureResult({
                  executionId: execution.execution_id,
                  workerId: execution.worker_id,
                  code: "WORKER_RUNTIME_ERROR",
                  message,
                  startedAt: execution.started_at,
                  suggestedNextStep: "Inspect worker adapter status polling and retry or request human decision"
                })
              },
              {
                demand_id: execution.demand_id,
                subgoal_id: execution.subgoal_id,
                execution_id: execution.execution_id,
                worker_id: execution.worker_id
              }
            )
          );
        }
      }
    }, 2000);
  }
}
