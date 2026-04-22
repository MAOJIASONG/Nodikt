import { WorkerRegistration } from "../domain/index.js";

import { WorkerAdapter } from "./contract.js";

export class AdapterRegistry {
  private readonly adapters = new Map<string, WorkerAdapter>();
  private readonly executionAdapter = new Map<string, WorkerAdapter>();
  private readonly workers = new Map<string, WorkerRegistration>();

  registerAdapter(workerId: string, worker: WorkerRegistration, adapter: WorkerAdapter): void {
    this.adapters.set(workerId, adapter);
    this.workers.set(workerId, worker);
  }

  getAdapter(workerId: string): WorkerAdapter | undefined {
    return this.adapters.get(workerId);
  }

  bindExecution(executionId: string, workerId: string): void {
    const adapter = this.adapters.get(workerId);
    if (!adapter) {
      throw new Error(`Missing adapter for worker ${workerId}`);
    }
    this.executionAdapter.set(executionId, adapter);
  }

  getExecutionAdapter(executionId: string): WorkerAdapter | undefined {
    return this.executionAdapter.get(executionId);
  }

  getWorker(workerId: string): WorkerRegistration | undefined {
    return this.workers.get(workerId);
  }
}
