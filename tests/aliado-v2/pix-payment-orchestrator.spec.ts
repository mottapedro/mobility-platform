import bcrypt from "bcrypt";
import {
  DomainEventType,
  PaymentStatus,
  RideStatus,
} from "../../src/shared/enums";
import { prisma } from "../setup";
import { createEventBus } from "../../src/domain/shared/events/EventBus";
import { InMemoryPixProvider } from "../../src/domain/payment/providers/InMemoryPixProvider";
import { execute as orchestrate } from "../../src/application/services/PixPaymentOrchestrator";
import { PLATFORM_FEE_CENTS } from "../../src/domain/payment/RevenueSplitService";

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
    data: { userId: u.id, isActive: true, experienceLevel: "PROFISSIONAL", regions: ["ZN"] },
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

async function seedRide(
  tag: string,
  opts: { withRoot: boolean }
): Promise<{ driverId: string; rideId: string }> {
  const driver = await makeDriver(`ppo.${tag}.${Math.random().toString(36).slice(2, 6)}@test.com`);
  const passenger = await makePassenger(
    `ppo.${tag}.${Math.random().toString(36).slice(2, 6)}@test.com`,
    opts.withRoot ? driver.id : null
  );
  const ride = await prisma.rideRequest.create({
    data: {
      passengerId: passenger.id,
      origin: "A",
      destination: "B",
      scheduledAt: new Date(),
      status: RideStatus.COMPLETED,
      selectedDriverId: driver.id,
    },
  });
  return { driverId: driver.id, rideId: ride.id };
}

describe("PixPaymentOrchestrator", () => {
  // ADR-001 §3: platformFee = R$2,50 fixed; driver = total - 2,50; rootDriver = 0
  it("generates QR, confirms settlement, distributes rewards (with rootDriver)", async () => {
    const totalCents = 10_000;
    const { rideId } = await seedRide("happy", { withRoot: true });

    const seen: DomainEventType[] = [];
    const bus = createEventBus();
    bus.subscribe(DomainEventType.PAYMENT_INTENT_CREATED, async () => {
      seen.push(DomainEventType.PAYMENT_INTENT_CREATED);
    });
    bus.subscribe(DomainEventType.PIX_QRCODE_GENERATED, async () => {
      seen.push(DomainEventType.PIX_QRCODE_GENERATED);
    });
    bus.subscribe(DomainEventType.PAYMENT_CONFIRMED, async () => {
      seen.push(DomainEventType.PAYMENT_CONFIRMED);
    });
    bus.subscribe(DomainEventType.RIDE_SETTLED, async () => {
      seen.push(DomainEventType.RIDE_SETTLED);
    });
    bus.subscribe(DomainEventType.REWARD_DISTRIBUTED, async () => {
      seen.push(DomainEventType.REWARD_DISTRIBUTED);
    });

    const result = await orchestrate(
      { rideRequestId: rideId, amountCents: totalCents },
      { provider: new InMemoryPixProvider(), bus }
    );

    // Payment intent was confirmed
    expect(result.intent.status).toBe(PaymentStatus.CONFIRMED);
    expect(result.intent.rideRequestId).toBe(rideId);
    expect(result.qrCode).not.toBeNull();

    // Settlement created fresh
    expect(result.settled).toBe(true);
    expect(result.settlement.totalCents).toBe(totalCents);

    // Revenue splits: in compose path SettlementService already created splits,
    // so RewardDistributionService is idempotent and returns distributed:false
    expect(result.distributed).toBe(false);

    // ADR-001 §3: fixed-fee model — no percentage split
    const platformExpected = PLATFORM_FEE_CENTS; // R$2,50
    const driverExpected = totalCents - platformExpected;
    expect(result.platformCents).toBe(platformExpected);
    expect(result.driverCents).toBe(driverExpected);
    expect(result.rootDriverCents).toBe(0); // Reserved for RevenueSplit V2
    expect(result.rootDriverId).not.toBeNull();

    // Full event chain fired
    expect(seen).toContain(DomainEventType.PAYMENT_INTENT_CREATED);
    expect(seen).toContain(DomainEventType.PIX_QRCODE_GENERATED);
    expect(seen).toContain(DomainEventType.PAYMENT_CONFIRMED);
    expect(seen).toContain(DomainEventType.RIDE_SETTLED);
    expect(seen).toContain(DomainEventType.REWARD_DISTRIBUTED);
  });

  it("is idempotent: second call returns settled=false", async () => {
    const totalCents = 5_000;
    const { rideId } = await seedRide("idem", { withRoot: false });

    const bus = createEventBus();
    const provider = new InMemoryPixProvider();

    // First call
    const first = await orchestrate({ rideRequestId: rideId, amountCents: totalCents }, { provider, bus });
    expect(first.settled).toBe(true);

    // Second call
    const second = await orchestrate({ rideRequestId: rideId, amountCents: totalCents }, { provider, bus });
    expect(second.settled).toBe(false);
    expect(second.distributed).toBe(false);
    expect(second.settlement.id).toBe(first.settlement.id);
    expect(second.intent.id).toBe(first.intent.id);
  });

  it("no-root: rootDriverCents=0; full driver/platform split still applies", async () => {
    const totalCents = 8_000;
    const { rideId } = await seedRide("noroot", { withRoot: false });

    const bus = createEventBus();
    const result = await orchestrate(
      { rideRequestId: rideId, amountCents: totalCents },
      { provider: new InMemoryPixProvider(), bus }
    );

    expect(result.settled).toBe(true);
    expect(result.platformCents).toBe(PLATFORM_FEE_CENTS);          // R$2,50
    expect(result.driverCents).toBe(totalCents - PLATFORM_FEE_CENTS); // remainder
    expect(result.rootDriverCents).toBe(0);
    expect(result.rootDriverId).toBeNull();
  });
});
