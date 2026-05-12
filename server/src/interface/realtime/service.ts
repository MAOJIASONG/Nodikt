/**
 * 文件名称：service.ts
 * 文件作用：实时广播服务，负责通过 WebSocket 向客户端推送调度事件和需求视图更新。
 *
 * 主要职责：
 * 1. 管理 WebSocket 客户端连接集合。
 * 2. 广播事件总线产生的调度事件。
 * 3. 在需求数据变化时推送最新需求视图。
 *
 * 依赖模块：
 * - ws：WebSocket 服务端实现。
 * - domain：需求视图和调度事件类型。
 * - brain/store/repositories：读取需求相关数据。
 *
 * 注意事项：
 * - 广播内容应保持前端可直接消费，避免暴露不必要的内部实现细节。
 * - 连接异常应局部处理，避免影响主调度流程。
 */
import { WebSocketServer } from "ws";

import { DemandView, SchedulerEvent } from "../../domain/index.js";
import { RepositoryBundle } from "../../brain/store/repositories/index.js";
import { deriveSessionFromDemand } from "../../brain/scheduler/handlers/sessionState.js";

export class WsBroadcaster {
  constructor(
    private readonly wss: WebSocketServer,
    private readonly repositories: RepositoryBundle
  ) {}

  /**
   * 函数作用：广播调度事件，并在关联需求存在时同步推送最新需求视图。
   *
   * 参数说明：
   * - event：需要推送给前端的调度事件。
   *
   * 返回值：
   * - Promise<void>：广播完成后无返回数据。
   */
  async broadcastEvent(event: SchedulerEvent): Promise<void> {
    this.broadcast({
      type: "event",
      payload: event
    });

    if (event.demand_id) {
      this.broadcast({
        type: "demand_view",
        payload: await this.getDemandView(event.demand_id)
      });
    }

    this.broadcast({
      type: "workers",
      payload: await this.repositories.workers.list()
    });
  }

  /**
   * 函数作用：组装前端可消费的需求详情视图。
   *
   * 参数说明：
   * - demandId：需要查询的需求 ID。
   *
   * 返回值：
   * - DemandView | null：找到需求时返回聚合视图，否则返回 null。
   */
  async getDemandView(demandId: string): Promise<DemandView | null> {
    const demand = await this.repositories.demands.getById(demandId);
    if (!demand) {
      return null;
    }

    const [session, subgoals, executions, decisions, memory, events] = await Promise.all([
      this.repositories.sessions.getById(`session_${demandId}`),
      this.repositories.subgoals.list(),
      this.repositories.executions.list(),
      this.repositories.decisions.list(),
      this.repositories.memory.list(),
      this.repositories.events.list()
    ]);

    const demandSession = session ?? deriveSessionFromDemand(demand);

    return {
      demand,
      session: demandSession,
      subgoals: subgoals.filter((item) => item.demand_id === demandId),
      executions: executions.filter((item) => item.demand_id === demandId),
      decisions: decisions.filter((item) => item.demand_id === demandId),
      memory: memory.filter((item) => item.demand_id === demandId),
      events: events.filter((item) => item.demand_id === demandId)
    };
  }

  /**
   * 函数作用：向所有已连接 WebSocket 客户端发送消息。
   *
   * 参数说明：
   * - payload：可 JSON 序列化的广播载荷。
   *
   * 返回值：
   * - void：发送过程不返回业务数据。
   */
  broadcast(payload: unknown): void {
    const serialized = JSON.stringify(payload);
    for (const client of this.wss.clients) {
      if (client.readyState === 1) {
        client.send(serialized);
      }
    }
  }
}
