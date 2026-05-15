/**
 * 文件名称：eventBus.ts
 * 文件作用：调度事件总线实现，负责持久化事件并按事件类型分发给对应处理器。
 *
 * 主要职责：
 * 1. 保存调度事件到事件仓储。
 * 2. 根据事件类型查找并执行事件处理器。
 * 3. 为处理器注入仓储、服务和发布函数上下文。
 * 4. 支持处理器继续发布后续事件，形成调度链路。
 *
 * 依赖模块：
 * - domain：事件类型和调度事件结构。
 * - brain/store/repositories：事件持久化仓储。
 * - event_bus/types：处理器上下文和映射类型。
 *
 * 注意事项：
 * - 事件发布是调度流程核心入口，处理器异常应被清晰记录和暴露。
 * - 事件载荷结构应与 domain/types 和 validators 保持一致。
 */
import { EventType, SchedulerEvent } from "../../../domain/index.js";
import { RepositoryBundle } from "../../store/repositories/index.js";
import { applySessionEvent } from "../session/sessionReducer.js";
import { HandlerContext, HandlerMap } from "./types.js";

const TRANSIENT_EVENT_TYPES = new Set<EventType>([
  EventType.WORKER_HEARTBEAT_RECEIVED,
  EventType.WORKER_HEALTH_CHECKED
]);

export class EventBus {
  constructor(
    private readonly handlers: HandlerMap,
    private readonly repositories: RepositoryBundle,
    private readonly contextFactory: (publish: (event: SchedulerEvent<unknown>) => Promise<void>) => Omit<HandlerContext, "publish">
  ) {}

  /**
   * 函数作用：发布调度事件并触发对应处理器。
   *
   * 参数说明：
   * - event：待发布的调度事件。
   *
   * 返回值：
   * - Promise<void>：事件持久化和处理完成后无返回数据。
   *
   * 注意事项：
   * - 本函数会先保存事件，再执行处理器；处理器可继续发布后续事件。
   */
  async publish(event: SchedulerEvent<unknown>): Promise<void> {
    if (!TRANSIENT_EVENT_TYPES.has(event.event_type as EventType)) {
      await this.repositories.events.upsert(event as SchedulerEvent<Record<string, unknown>>);
    }
    const handler = this.handlers[event.event_type as EventType];
    if (!handler) {
      const ctx = this.contextFactory(this.publish.bind(this));
      await applySessionEvent(event, this.repositories);
      await ctx.wsBroadcaster.broadcastEvent(event);
      return;
    }

    const ctx: HandlerContext = {
      ...this.contextFactory(this.publish.bind(this)),
      publish: this.publish.bind(this)
    };

    const result = await handler(event, ctx);
    await applySessionEvent(event, this.repositories);
    await ctx.wsBroadcaster.broadcastEvent(event);

    if (result.events) {
      for (const followupEvent of result.events) {
        await this.publish(followupEvent);
      }
    }
  }
}
