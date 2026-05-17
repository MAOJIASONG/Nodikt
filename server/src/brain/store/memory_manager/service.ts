/**
 * 文件名称：service.ts
 * 文件作用：记忆管理服务，负责从工作器结果和验证结果中沉淀可复用记忆记录，并对外提供检索摘要。
 *
 * 主要职责：
 * 1. 将成功/失败执行的摘要、轨迹与教训记录为需求级记忆。
 * 2. 将验证过程中的阻塞信息记录为后续调度参考。
 * 3. 为派发与重规划提供经过分类与裁剪的记忆快照，作为渐进反馈闭环的输入。
 * 4. 为记忆记录生成统一 ID 和时间戳。
 *
 * 依赖模块：
 * - domain：记忆、验证结果、工作器结果和工具函数。
 * - store/repositories：在按需查询历史记忆时读取持久化的记忆集合。
 */
import { MemoryRecord, VerificationResult, WorkerResult, createId, nowIso } from "../../../domain/index.js";
import { RepositoryBundle } from "../repositories/index.js";

/**
 * 类型作用：派发与重规划阶段使用的记忆摘要。
 */
export interface DispatchMemorySnapshot {
  missionStateSummary: string | null;
  recentTraces: string[];
  lessons: string[];
}

export interface DispatchMemorySnapshotOptions {
  traceLimit?: number;
  lessonLimit?: number;
}

const EMPTY_SNAPSHOT: DispatchMemorySnapshot = {
  missionStateSummary: null,
  recentTraces: [],
  lessons: []
};

export class MemoryManager {
  /**
   * 函数作用：从执行结果和验证结果中生成记忆记录。
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

  /**
   * 函数作用：按需求读取最近的分类记忆，组装派发用快照。
   * 当当前需求未产生过记忆时返回空快照而非抛错，避免阻断派发链路。
   */
  async getDispatchMemorySnapshot(
    repositories: RepositoryBundle,
    demandId: string,
    options?: DispatchMemorySnapshotOptions
  ): Promise<DispatchMemorySnapshot> {
    if (!demandId) {
      return EMPTY_SNAPSHOT;
    }

    const all = await repositories.memory.list();
    const scoped = all.filter((record) => record.demand_id === demandId);
    if (scoped.length === 0) {
      return EMPTY_SNAPSHOT;
    }

    const sortDesc = (records: MemoryRecord[]): MemoryRecord[] =>
      [...records].sort((left, right) => right.updated_at.localeCompare(left.updated_at));

    const traceLimit = Math.max(0, options?.traceLimit ?? 5);
    const lessonLimit = Math.max(0, options?.lessonLimit ?? 5);

    const missionState = sortDesc(scoped.filter((record) => record.category === "mission_state"))[0];
    const traces = sortDesc(scoped.filter((record) => record.category === "episodic_trace"))
      .slice(0, traceLimit)
      .map((record) => record.content)
      .filter((content) => content.trim().length > 0);
    const lessons = sortDesc(scoped.filter((record) => record.category === "lessons_or_policy"))
      .slice(0, lessonLimit)
      .map((record) => record.content)
      .filter((content) => content.trim().length > 0);

    return {
      missionStateSummary: missionState?.content?.trim() || null,
      recentTraces: traces,
      lessons
    };
  }
}
