/**
 * 文件名称：index.ts
 * 文件作用：仓储集合装配入口，负责创建并暴露所有领域数据仓储实例。
 *
 * 主要职责：
 * 1. 绑定各类集合文件名、ID 字段和校验 schema。
 * 2. 初始化需求、子目标、执行、工作器、决策、事件、记忆和设置仓储。
 * 3. 为应用层提供统一 RepositoryBundle。
 *
 * 依赖模块：
 * - domain/validators：各集合数据校验 schema。
 * - CollectionRepository：通用集合仓储。
 * - JsonFileStore：底层 JSON 文件存储。
 * - SettingsRepository：系统设置仓储。
 *
 * 注意事项：
 * - 新增持久化集合时，应在这里完成文件名、schema 和 ID 字段配置。
 * - 仓储路径由应用装配层传入，避免在业务模块硬编码数据目录。
 */
import path from "path";

import {
  DecisionRequest,
  Demand,
  Execution,
  MemoryRecord,
  SchedulerEvent,
  Settings,
  SubgoalContract,
  WorkerRegistration
} from "../../../domain/types.js";
import {
  decisionRequestSchema,
  decisionsCollectionSchema,
  demandSchema,
  demandsCollectionSchema,
  eventsCollectionSchema,
  executionSchema,
  executionsCollectionSchema,
  memoryCollectionSchema,
  memoryRecordSchema,
  schedulerEventSchema,
  settingsSchema,
  subgoalContractSchema,
  subgoalsCollectionSchema,
  workerRegistrationSchema,
  workersCollectionSchema
} from "../../../domain/validators.js";
import { CollectionRepository } from "./collectionRepository.js";
import { JsonFileStore } from "./fileStore.js";
import { SettingsRepository } from "./settingsRepository.js";

export class RepositoryBundle {
  public readonly store: JsonFileStore;
  public readonly demands: CollectionRepository<Demand>;
  public readonly subgoals: CollectionRepository<SubgoalContract>;
  public readonly executions: CollectionRepository<Execution>;
  public readonly workers: CollectionRepository<WorkerRegistration>;
  public readonly decisions: CollectionRepository<DecisionRequest>;
  public readonly events: CollectionRepository<SchedulerEvent<Record<string, unknown>>>;
  public readonly memory: CollectionRepository<MemoryRecord>;
  public readonly settings: SettingsRepository;

  constructor(dataDir: string) {
    this.store = new JsonFileStore(path.resolve(dataDir));
    this.demands = new CollectionRepository(this.store, "demands.json", "demand_id", demandsCollectionSchema, demandSchema);
    this.subgoals = new CollectionRepository(this.store, "subgoals.json", "subgoal_id", subgoalsCollectionSchema, subgoalContractSchema);
    this.executions = new CollectionRepository(this.store, "executions.json", "execution_id", executionsCollectionSchema, executionSchema);
    this.workers = new CollectionRepository(this.store, "workers.json", "worker_id", workersCollectionSchema, workerRegistrationSchema);
    this.decisions = new CollectionRepository(this.store, "decisions.json", "decision_id", decisionsCollectionSchema, decisionRequestSchema);
    this.events = new CollectionRepository(this.store, "events.json", "event_id", eventsCollectionSchema, schedulerEventSchema);
    this.memory = new CollectionRepository(this.store, "memory.json", "memory_id", memoryCollectionSchema, memoryRecordSchema);
    this.settings = new SettingsRepository(this.store, "settings.json", settingsSchema);
  }

  /**
   * 函数作用：读取系统设置的便捷入口。
   *
   * 参数说明：
   * - 无。
   *
   * 返回值：
   * - Promise<Settings>：当前系统设置。
   */
  async loadSettings(): Promise<Settings> {
    return this.settings.load();
  }
}
