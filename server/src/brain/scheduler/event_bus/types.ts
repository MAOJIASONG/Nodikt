/**
 * 文件名称：types.ts
 * 文件作用：事件总线类型定义，描述事件处理器运行时可访问的上下文和处理器映射。
 *
 * 主要职责：
 * 1. 定义 HandlerContext，集中声明调度处理器依赖。
 * 2. 定义事件处理函数签名和事件类型到处理器的映射。
 * 3. 为事件总线与各处理器模块提供类型契约。
 *
 * 依赖模块：
 * - domain：事件类型、调度事件和处理结果类型。
 * - brain/*：调度处理器依赖的业务服务。
 * - worker/adapters/registry：工作器适配器注册表。
 * - interface/realtime：实时广播服务。
 *
 * 注意事项：
 * - 上下文新增依赖时，应同步更新 app.ts 中事件总线创建逻辑。
 * - 处理器签名应保持稳定，避免大范围调用方调整。
 */
import { EventType, HandlerResult, SchedulerEvent } from "../../../domain/index.js";
import { AdapterRegistry } from "../../../worker/adapters/registry.js";
import { DecisionService } from "../../engines/decision/service.js";
import { DispatcherService } from "../../dispatch/dispatcher/service.js";
import { MemoryManager } from "../../store/memory_manager/service.js";
import { OpsMonitor } from "../../ops/service.js";
import { PlannerService } from "../../engines/planner/service.js";
import { ReconciliationService } from "../../review/reconciliation/service.js";
import { RepositoryBundle } from "../../store/repositories/index.js";
import { VerifierService } from "../../review/verifier/service.js";
import { WsBroadcaster } from "../../../interface/realtime/service.js";

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
