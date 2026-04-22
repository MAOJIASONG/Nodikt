import { MemoryRecord, VerificationResult, WorkerResult, createId, nowIso } from "../domain/index.js";

export class MemoryManager {
  createExecutionMemories(input: {
    demandId: string;
    workerResult: WorkerResult;
    verification: VerificationResult;
  }): MemoryRecord[] {
    const timestamp = nowIso();
    return [
      {
        memory_id: createId("memory"),
        demand_id: input.demandId,
        category: "mission_state",
        content: `Verification status: ${input.verification.verified_status}`,
        created_at: timestamp,
        updated_at: timestamp
      },
      {
        memory_id: createId("memory"),
        demand_id: input.demandId,
        category: "episodic_trace",
        content: input.workerResult.compressed_history,
        created_at: timestamp,
        updated_at: timestamp
      },
      {
        memory_id: createId("memory"),
        demand_id: input.demandId,
        category: "lessons_or_policy",
        content: `Last execution produced status ${input.workerResult.worker_status}`,
        created_at: timestamp,
        updated_at: timestamp
      }
    ];
  }
}
