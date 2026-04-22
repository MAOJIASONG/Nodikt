import { WebSocketServer } from "ws";

import { DemandView, SchedulerEvent } from "../domain/index.js";
import { RepositoryBundle } from "../repositories/index.js";

export class WsBroadcaster {
  constructor(
    private readonly wss: WebSocketServer,
    private readonly repositories: RepositoryBundle
  ) {}

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

  async getDemandView(demandId: string): Promise<DemandView | null> {
    const demand = await this.repositories.demands.getById(demandId);
    if (!demand) {
      return null;
    }

    const [subgoals, executions, decisions, memory, events] = await Promise.all([
      this.repositories.subgoals.list(),
      this.repositories.executions.list(),
      this.repositories.decisions.list(),
      this.repositories.memory.list(),
      this.repositories.events.list()
    ]);

    return {
      demand,
      subgoals: subgoals.filter((item) => item.demand_id === demandId),
      executions: executions.filter((item) => item.demand_id === demandId),
      decisions: decisions.filter((item) => item.demand_id === demandId),
      memory: memory.filter((item) => item.demand_id === demandId),
      events: events.filter((item) => item.demand_id === demandId)
    };
  }

  broadcast(payload: unknown): void {
    const serialized = JSON.stringify(payload);
    for (const client of this.wss.clients) {
      if (client.readyState === 1) {
        client.send(serialized);
      }
    }
  }
}
