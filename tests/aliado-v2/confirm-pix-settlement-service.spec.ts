import bcrypt from "bcrypt";
import {
  DomainEventType,
  PaymentStatus,
  RideStatus,
} from "../../src/shared/enums";
import { prisma } from "../setup";
import { createEventBus } from "../../src/domain/shared/events/EventBus";
import { InMemoryPixProvider } from "../../src/domain/payment/providers/InMemoryPixProvider";
import { createPaymentIntent } from "../../src/domain/payment/PaymentIntentService";
import { execute as confirmPixSettlement } from "../../src/application/services/ConfirmPixSettlementService";

async function makeDriver(email: string) {
  const u = await prisma.user.create({
    data: {
      name: email,
      email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "DRIVER",
      passwordHash: await bcrypt.hash("x", 4),
    },
  });
  return prisma.driver.create({
    data: { userId: u.id, isActive: true, experienceLevel: "INTERMEDIARIO", regions: ["ZN"] },
  });
}

async function makePassenger(email: string, rootDriverId: string | null) {
  const u = await prisma.user.create({
    data: {
      name: email,
      email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "PASSENGER",
      passwordHash: await bcrypt.hash("x", 4),
    },
  });
  return prisma.passenger.create({
    data: {
      userId: u.id,
      referralCode: `r-${u.id.slice(0, 6)}`,
      publicSlug: `s-${u.id.slice(0, 6)}`,
      rootDriverId: rootDriverId ?? undefined,
    },
  });
}

async function makeCompletedRide(passengerId: string, driverId: string) {
  return prisma.rideRequest.create({
    data: {
      passengerId,
      origin: "A",
      destination: "B",
      scheduledAt: new Date(),
      status: RideStatus.COMPLETED,
      selectedDriverId: driverId,
    },
  });
}

async function seedIntent(amountCents: number, withRoot: boolean) {
  const driver = await makeDriver(`cps.${Math.random().toString(36).slice(2, 8)}@test.com`);
  const passenger = await makePassenger(
    `cps.${Math.random().toString(36).slice(2, 8)}@test.com`,
    withRoot ? driver.id : null
  );
  const ride = await makeCompletedRide(passenger.id, driver.id);
  const intent = await createPaymentIntent({
    rideRequestId: ride.id,
    amountCents,
    provider: new InMemoryPixProvider(),
    bus: createEventBus(),
  });
  return { driver, passenger, ride, intent };
}

describe("ConfirmPixSettlementService (application)", () => {
  it("confirms a PENDING intent, runs settlement, marks ride PAID and emits the full chain", async () => {
    const { intent, ride } = await seedIntent(4500, true);
    expect(intent.externalId).not.toBeNull();

    const seen: DomainEventType[] = [];
    const bus = createEventBus();
    bus.subscribe(DomainEventType.PAYMENT_CONFIRMED, async () => {
      seen.push(DomainEventType.PAYMENT_CONFIRMED);
    });
    bus.subscribe(DomainEventType.RIDE_SETTLED, async () => {
      seen.push(DomainEventType.RIDE_SETTLED);
    });
    bus.subscribe(DomainEventType.REWARD_DISTRIBUTED, async () => {
      seen.push(DomainEventType.REWARD_DISTRIBUTED);
    });

    const result = await confirmPixSettlement(
      { externalId: intent.externalId! },
      { bus }
    );

    expect(result.settled).toBe(true);
    expect(result.intent.status).toBe(PaymentStatus.CONFIRMED);
    expect(result.settlement.paymentIntentId).toBe(intent.id);
    expect(result.settlement.totalCents).toBe(4500);
    expect(seen).toEqual([
      DomainEventType.PAYMENT_CONFIRMED,
      DomainEventType.RIDE_SETTLED,
      DomainEventType.REWARD_DISTRIBUTED,
    ]);

    const reloadedRide = await prisma.rideRequest.findUnique({ where: { id: ride.id } });
    expect(reloadedRide?.status).toBe(RideStatus.PAID);
  });

  it("is idempotent: second call returns settled=false and does not duplicate events", async () => {
    const { intent } = await seedIntent(3000, false);

    const seenCounts = {
      [DomainEventType.PAYMENT_CONFIRMED]: 0,
      [DomainEventType.RIDE_SETTLED]: 0,
      [DomainEventType.REWARD_DISTRIBUTED]: 0,
    };
    const bus = createEventBus();
    bus.subscribe(DomainEventType.PAYMENT_CONFIRMED, async () => {
      seenCounts[DomainEventType.PAYMENT_CONFIRMED]++;
    });
    bus.subscribe(DomainEventType.RIDE_SETTLED, async () => {
      seenCounts[DomainEventType.RIDE_SETTLED]++;
    });
    bus.subscribe(DomainEventType.REWARD_DISTRIBUTED, async () => {
      seenCounts[DomainEventType.REWARD_DISTRIBUTED]++;
    });

    const first = await confirmPixSettlement(
      { externalId: intent.externalId! },
      { bus }
    );
    const second = await confirmPixSettlement(
      { externalId: intent.externalId! },
      { bus }
    );

    expect(first.settled).toBe(true);
    expect(second.settled).toBe(false);
    expect(second.settlement.id).toBe(first.settlement.id);
    expect(seenCounts[DomainEventType.PAYMENT_CONFIRMED]).toBe(1);
    expect(seenCounts[DomainEventType.RIDE_SETTLED]).toBe(1);
    expect(seenCounts[DomainEventType.REWARD_DISTRIBUTED]).toBe(1);

    const persisted = await prisma.domainEvent.findMany({
      where: {
        aggregateId: intent.id,
        type: DomainEventType.PAYMENT_CONFIRMED,
      },
    });
    expect(persisted).toHaveLength(1);
  });

  it("throws when externalId is unknown", async () => {
    const bus = createEventBus();
    await expect(
      confirmPixSettlement({ externalId: "pix_does_not_exist" }, { bus })
    ).rejects.toThrow(/ConfirmPixSettlement: PaymentIntent with externalId=/);
  });
});
