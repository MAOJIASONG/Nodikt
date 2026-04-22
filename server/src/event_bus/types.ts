import { EventType, HandlerResult, SchedulerEvent } from "../domain/index.js";
import { AdapterRegistry } from "../worker_adapters/registry.js";
import { DecisionService } from "../decision/service.js";
import { DispatcherService } from "../dispatcher/service.js";
import { MemoryManager } from "../memory_manager/service.js";
import { OpsMonitor } from "../ops_monitor/service.js";
import { PlannerService } from "../planner/service.js";
import { ReconciliationService } from "../reconciliation/service.js";
import { RepositoryBundle } from "../repositories/index.js";
import { VerifierService } from "../verifier/service.js";
import { WsBroadcaster } from "../ws_broadcaster/service.js";

export interface HandlerContext {
  repositories: RepositoryBundle;
  planner: PlannerService;
  dispatcher: DispatcherService;
  verifier: VerifierService;
  reconciliation: ReconciliationService;
  decisionService: DecisionService;
  memoryManager: MemoryManager;
  adapterRegistry: AdapterRegistry;
  wsBroadcaster: WsBroadcaster;
  opsMonitor: OpsMonitor;
  publish: (event: SchedulerEvent<unknown>) => Promise<void>;
}

export type EventHandler = (event: SchedulerEvent<unknown>, ctx: HandlerContext) => Promise<HandlerResult>;

export type HandlerMap = Partial<Record<EventType, EventHandler>>;
