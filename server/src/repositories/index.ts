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
} from "../domain/types.js";
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
} from "../domain/validators.js";
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

  async loadSettings(): Promise<Settings> {
    return this.settings.load();
  }
}
