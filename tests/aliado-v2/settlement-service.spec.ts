import bcrypt from "bcrypt";
import { DomainEventType, RideStatus } from "../../src/shared/enums";
import { prisma } from "../setup";
import { createEventBus } from "../../src/domain/shared/events/EventBus";
import { settleConfirmedPayment } from "../../src/domain/payment/SettlementService";

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

async function makeRide(passengerId: string, driverId: string | null) {
  return prisma.rideRequest.create({
    data: {
      passengerId,
      origin: "A",
      destination: "B",
      scheduledAt: new Date(),
      status: RideStatus.COMPLETED,
      selectedDriverId: driverId ?? undefined,
    },
  });
}

async function makeIntent(rideRequestId: string, amountCents: number) {
  return prisma.paymentIntent.create({
    data: {
      rideRequestId,
      amountCents,
      status: "CONFIRMED",
      externalId: `pix_${rideRequestId}`,
      confirmedAt: new Date(),
    },
  });
}

describe("SettlementService", () => {
  it("creates Settlement + 3 RevenueSplit rows when rootDriverId is set", async () => {
    const driver = await makeDriver("settle.driver@test.com");
    const root = await makeDriver("settle.root@test.com");
    const passenger = await makePassenger("settle.passenger@test.com", root.id);
    const ride = await makeRide(passenger.id, driver.id);
    const intent = await makeIntent(ride.id, 10_000);

    const bus = createEventBus();
    const result = await settleConfirmedPayment(intent.id, bus);

    expect(result.totalCents).toBe(10_000);
    expect(result.driverCents).toBe(8000);
    expect(result.platformCents).toBe(1500);
    expect(result.rootDriverCents).toBe(500);
    expect(result.rootDriverId).toBe(root.id);

    const splits = await prisma.revenueSplit.findMany({
      where: { settlementId: result.id },
      orderBy: { beneficiaryType: "asc" },
    });
    expect(splits).toHaveLength(3);
  });

  it("transitions RideRequest.status to PAID", async () => {
    const driver = await makeDriver("settle.paid.driver@test.com");
    const passenger = await makePassenger("settle.paid.passenger@test.com", null);
    const ride = await makeRide(passenger.id, driver.id);
    const intent = await makeIntent(ride.id, 5000);

    await settleConfirmedPayment(intent.id, createEventBus());

    const updated = await prisma.rideRequest.findUnique({ where: { id: ride.id } });
    expect(updated?.status).toBe(RideStatus.PAID);
  });

  it("publishes RIDE_SETTLED and REWARD_DISTRIBUTED", async () => {
    const driver = await makeDriver("settle.events.driver@test.com");
    const root = await makeDriver("settle.events.root@test.com");
    const passenger = await makePassenger(
      "settle.events.passenger@test.com",
      root.id
    );
    const ride = await makeRide(passenger.id, driver.id);
    const intent = await makeIntent(ride.id, 2000);

    const bus = createEventBus();
    const seen: DomainEventType[] = [];
    bus.subscribe(DomainEventType.RIDE_SETTLED, async () => {
      seen.push(DomainEventType.RIDE_SETTLED);
    });
    bus.subscribe(DomainEventType.REWARD_DISTRIBUTED, async () => {
      seen.push(DomainEventType.REWARD_DISTRIBUTED);
    });

    await settleConfirmedPayment(intent.id, bus);
    expect(seen).toContain(DomainEventType.RIDE_SETTLED);
    expect(seen).toContain(DomainEventType.REWARD_DISTRIBUTED);
  });

  it("is idempotent — second call returns the existing settlement", async () => {
    const driver = await makeDriver("settle.idem.driver@test.com");
    const passenger = await makePassenger("settle.idem.passenger@test.com", null);
    const ride = await makeRide(passenger.id, driver.id);
    const intent = await makeIntent(ride.id, 3000);

    const a = await settleConfirmedPayment(intent.id, createEventBus());
    const b = await settleConfirmedPayment(intent.id, createEventBus());
    expect(a.id).toBe(b.id);

    const count = await prisma.settlement.count({
      where: { paymentIntentId: intent.id },
    });
    expect(count).toBe(1);
  });

  it("refuses to settle a payment that is not CONFIRMED", async () => {
    const driver = await makeDriver("settle.pending.driver@test.com");
    const passenger = await makePassenger("settle.pending.passenger@test.com", null);
    const ride = await makeRide(passenger.id, driver.id);
    const intent = await prisma.paymentIntent.create({
      data: {
        rideRequestId: ride.id,
        amountCents: 1000,
        status: "PENDING",
      },
    });

    await expect(
      settleConfirmedPayment(intent.id, createEventBus())
    ).rejects.toThrow();
  });
});
