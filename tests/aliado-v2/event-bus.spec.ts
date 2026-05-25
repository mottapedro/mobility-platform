import { prisma } from "../setup";
import { DomainEventType } from "@prisma/client";
import {
  createEventBus,
  recordAndPublish,
} from "../../src/domain/shared/events/EventBus";

describe("EventBus", () => {
  beforeEach(async () => {
    await prisma.domainEvent.deleteMany({});
  });

  it("dispatches synchronously to subscribed handlers", async () => {
    const bus = createEventBus();
    const calls: string[] = [];
    bus.subscribe(DomainEventType.PAYMENT_INTENT_CREATED, async (e) => {
      calls.push(`h1:${e.aggregateId}`);
    });
    bus.subscribe(DomainEventType.PAYMENT_INTENT_CREATED, async (e) => {
      calls.push(`h2:${e.aggregateId}`);
    });

    await bus.publish({
      type: DomainEventType.PAYMENT_INTENT_CREATED,
      aggregateType: "PaymentIntent",
      aggregateId: "pi-1",
      payload: { amountCents: 100 },
    });

    expect(calls).toEqual(["h1:pi-1", "h2:pi-1"]);
  });

  it("does not call handlers for other event types", async () => {
    const bus = createEventBus();
    const calls: string[] = [];
    bus.subscribe(DomainEventType.PAYMENT_CONFIRMED, async () => {
      calls.push("confirmed");
    });

    await bus.publish({
      type: DomainEventType.PAYMENT_FAILED,
      aggregateType: "PaymentIntent",
      aggregateId: "pi-2",
      payload: {},
    });

    expect(calls).toEqual([]);
  });

  it("propagates handler errors to the publisher", async () => {
    const bus = createEventBus();
    bus.subscribe(DomainEventType.RIDE_SETTLED, async () => {
      throw new Error("handler boom");
    });

    await expect(
      bus.publish({
        type: DomainEventType.RIDE_SETTLED,
        aggregateType: "Settlement",
        aggregateId: "s-1",
        payload: {},
      })
    ).rejects.toThrow("handler boom");
  });
});

describe("recordAndPublish", () => {
  beforeEach(async () => {
    await prisma.domainEvent.deleteMany({});
  });

  it("persists a DomainEvent row and dispatches via the bus", async () => {
    const bus = createEventBus();
    const seen: string[] = [];
    bus.subscribe(DomainEventType.PIX_QRCODE_GENERATED, async (e) => {
      seen.push(e.aggregateId);
    });

    const row = await recordAndPublish(bus, {
      type: DomainEventType.PIX_QRCODE_GENERATED,
      aggregateType: "PaymentIntent",
      aggregateId: "pi-99",
      payload: { qrCode: "abc" },
    });

    expect(row.id).toBeDefined();
    expect(seen).toEqual(["pi-99"]);

    const persisted = await prisma.domainEvent.findUnique({ where: { id: row.id } });
    expect(persisted?.type).toBe(DomainEventType.PIX_QRCODE_GENERATED);
    expect(persisted?.aggregateId).toBe("pi-99");
    expect((persisted?.payload as { qrCode: string }).qrCode).toBe("abc");
  });
});
