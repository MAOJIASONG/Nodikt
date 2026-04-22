import { EventType, SchedulerEvent } from "../domain/index.js";
import { RepositoryBundle } from "../repositories/index.js";
import { HandlerContext, HandlerMap } from "./types.js";

export class EventBus {
  constructor(
    private readonly handlers: HandlerMap,
    private readonly repositories: RepositoryBundle,
    private readonly contextFactory: (publish: (event: SchedulerEvent<unknown>) => Promise<void>) => Omit<HandlerContext, "publish">
  ) {}

  async publish(event: SchedulerEvent<unknown>): Promise<void> {
    await this.repositories.events.upsert(event as SchedulerEvent<Record<string, unknown>>);
    const handler = this.handlers[event.event_type as EventType];
    if (!handler) {
      const ctx = this.contextFactory(this.publish.bind(this));
      await ctx.wsBroadcaster.broadcastEvent(event);
      return;
    }

    const ctx: HandlerContext = {
      ...this.contextFactory(this.publish.bind(this)),
      publish: this.publish.bind(this)
    };

    const result = await handler(event, ctx);
    await ctx.wsBroadcaster.broadcastEvent(event);

    if (result.events) {
      for (const followupEvent of result.events) {
        await this.publish(followupEvent);
      }
    }
  }
}
