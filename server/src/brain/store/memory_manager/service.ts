/**
 * 文件名称：service.ts
 * 文件作用：记忆管理服务，负责从工作器结果和验证结果中沉淀可复用记忆记录。
 *
 * 主要职责：
 * 1. 将成功执行的摘要和产物记录为需求级记忆。
 * 2. 将验证过程中的阻塞信息记录为后续调度参考。
 * 3. 为记忆记录生成统一 ID 和时间戳。
 *
 * 依赖模块：
 * - domain：记忆、验证结果、工作器结果和工具函数。
 *
 * 注意事项：
 * - 记忆内容应保持精简，避免把大量日志或敏感信息写入长期存储。
 * - 新增记忆类型时，应同步考虑前端展示和检索策略。
 */
import { MemoryRecord, VerificationResult, WorkerResult, createId, nowIso } from "../../../domain/index.js";

export class MemoryManager {
  /**
   * 函数作用：从执行结果和验证结果中生成记忆记录。
   *
   * 参数说明：
   * - input.demandId：所属需求 ID。
   * - input.subgoalId：所属子目标 ID。
   * - input.workerResult：工作器返回结果。
   * - input.verification：验证结果。
   *
   * 返回值：
   * - MemoryRecord[]：可写入记忆仓储的记录列表。
   */
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
