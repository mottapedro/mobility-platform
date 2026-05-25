import { DomainEvent, DomainEventType, Prisma } from "@prisma/client";
import { prisma } from "../../../infra/prisma/client";

/**
 * Lightweight, in-process event bus + persistent DomainEvent log.
 *
 * Design:
 *   - publish() dispatches to subscribers sequentially.
 *   - Errors propagate to the publisher (no silent swallow); the synchronous
 *     PAYMENT_CONFIRMED → RIDE_SETTLED → REWARD_DISTRIBUTED chain depends on
 *     deterministic failure semantics.
 *   - recordAndPublish() persists the event row BEFORE dispatch so the audit
 *     log is durable even if a handler later fails.
 */

export interface DomainEventEnvelope {
  type: DomainEventType;
  aggregateType: string;
  aggregateId: string;
  payload: Prisma.InputJsonValue;
}

export type DomainEventHandler = (event: DomainEventEnvelope) => Promise<void>;

export interface EventBus {
  subscribe(type: DomainEventType, handler: DomainEventHandler): void;
  publish(event: DomainEventEnvelope): Promise<void>;
}

export function createEventBus(): EventBus {
  const handlers = new Map<DomainEventType, DomainEventHandler[]>();

  return {
    subscribe(type, handler) {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
    async publish(event) {
      const list = handlers.get(event.type) ?? [];
      for (const handler of list) {
        await handler(event);
      }
    },
  };
}

type Db = Pick<typeof prisma, "domainEvent">;

export async function recordAndPublish(
  bus: EventBus,
  event: DomainEventEnvelope,
  db: Db = prisma
): Promise<DomainEvent> {
  const row = await db.domainEvent.create({
    data: {
      type: event.type,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: event.payload,
    },
  });
  await bus.publish(event);
  return row;
}
