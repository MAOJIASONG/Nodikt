import { WorkerDispatchPacket, WorkerHeartbeat, WorkerRegistration, WorkerResult } from "../domain/index.js";

export interface WorkerAdapter {
  register(config: WorkerRegistration): Promise<WorkerRegistration>;
  startExecution(packet: WorkerDispatchPacket): Promise<void>;
  stopExecution(executionId: string): Promise<void>;
  pollStatus(executionId: string): Promise<WorkerHeartbeat | null>;
  collectResult(executionId: string): Promise<WorkerResult | null>;
  healthCheck(workerId: string): Promise<{ ok: boolean; message: string }>;
}
