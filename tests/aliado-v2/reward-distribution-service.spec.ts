import bcrypt from "bcrypt";
import { PaymentStatus, RideStatus, SplitBeneficiaryType, DomainEventType } from "../../src/shared/enums";
import { prisma } from "../setup";
import { execute } from "../../src/application/services/RewardDistributionService";
import { createEventBus } from "../../src/domain/shared/events/EventBus";
import { PLATFORM_FEE_CENTS } from "../../src/domain/payment/RevenueSplitService";

// ─── helpers ─────────────────────────────────────────────────────────────────

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

async function makePassenger(email: string, rootDriverId: string | null = null) {
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
      referralCode: `rds-code-${u.id.slice(0, 6)}`,
      publicSlug: `rds-slug-${u.id.slice(0, 6)}`,
      ...(rootDriverId ? { rootDriverId } : {}),
    },
  });
}

/**
 * Creates all Settlement prerequisites (Driver, Passenger, RideRequest,
 * PaymentIntent) and then inserts a Settlement row directly — WITHOUT
 * RevenueSplit rows. This is the test baseline for RewardDistributionService.
 *
 * ADR-001 §3: platformCents = R$2,50 fixed; driverCents = total - 2,50;
 * rootDriverCents = 0 (reserved for RevenueSplit V2).
 */
async function seedSettlement(
  tag: string,
  totalCents: number,
  opts: { withRoot?: boolean } = {}
) {
  const driver = await makeDriver(`rds.driver.${tag}@test.com`);
  const rootDriverId = opts.withRoot ? driver.id : null;
  const passenger = await makePassenger(`rds.passenger.${tag}@test.com`, rootDriverId);

  const rideRequest = await prisma.rideRequest.create({
    data: {
      passengerId: passenger.id,
      selectedDriverId: driver.id,
      status: RideStatus.COMPLETED,
      priceOffered: totalCents / 100,
      originLat: -23.5,
      originLng: -46.6,
      destinationLat: -23.6,
      destinationLng: -46.7,
      origin: "Origem",
      destination: "Destino",
      scheduledAt: new Date(),
    },
  });

  const intent = await prisma.paymentIntent.create({
    data: {
      rideRequestId: rideRequest.id,
      amountCents: totalCents,
      method: "PIX",
      status: PaymentStatus.CONFIRMED,
      externalId: `pix_rds_${tag}_${Date.now()}`,
    },
  });

  // ADR-001 §3 fixed-fee model
  const platformCents = PLATFORM_FEE_CENTS; // R$2,50
  const driverCents = totalCents - platformCents;
  const rootDriverCents = 0; // Reserved for RevenueSplit V2

  const settlement = await prisma.settlement.create({
    data: {
      paymentIntentId: intent.id,
      rideRequestId: rideRequest.id,
      totalCents,
      driverCents,
      platformCents,
      rootDriverCents,
      rootDriverId,
    },
  });

  return { driver, passenger, rideRequest, intent, settlement };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("RewardDistributionService", () => {
  // ADR-001 §3+§4: 2 RevenueSplit rows (PLATFORM + DRIVER). ROOT_DRIVER reserved for V2.
  it("creates 2 RevenueSplit rows and emits REWARD_DISTRIBUTED (with rootDriver)", async () => {
    const totalCents = 10_000;
    const { driver, settlement } = await seedSettlement("happy", totalCents, { withRoot: true });
    const bus = createEventBus();

    const result = await execute({ settlementId: settlement.id }, { bus });

    expect(result.distributed).toBe(true);
    expect(result.platformCents).toBe(PLATFORM_FEE_CENTS);          // R$2,50
    expect(result.driverCents).toBe(totalCents - PLATFORM_FEE_CENTS);
    expect(result.rootDriverCents).toBe(0);
    expect(result.rootDriverId).toBe(driver.id);

    // 2 RevenueSplit rows created (PLATFORM + DRIVER — ROOT_DRIVER reserved for V2)
    const splits = await prisma.revenueSplit.findMany({
      where: { settlementId: settlement.id },
      orderBy: { beneficiaryType: "asc" },
    });
    expect(splits).toHaveLength(2);

    const driverSplit = splits.find((s) => s.beneficiaryType === SplitBeneficiaryType.DRIVER)!;
    expect(driverSplit.beneficiaryDriverId).toBe(driver.id);
    expect(driverSplit.amountCents).toBe(totalCents - PLATFORM_FEE_CENTS);

    const platformSplit = splits.find((s) => s.beneficiaryType === SplitBeneficiaryType.PLATFORM)!;
    expect(platformSplit.amountCents).toBe(PLATFORM_FEE_CENTS);
    expect(platformSplit.beneficiaryDriverId).toBeNull();

    // REWARD_DISTRIBUTED event persisted
    const events = await prisma.domainEvent.findMany({
      where: { type: DomainEventType.REWARD_DISTRIBUTED, aggregateId: settlement.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      driverId: driver.id,
      driverCents: totalCents - PLATFORM_FEE_CENTS,
      rootDriverCents: 0,
    });
  });

  it("is idempotent — second call returns distributed:false, counts stay at 2", async () => {
    const { settlement } = await seedSettlement("idem", 5_000, { withRoot: true });
    const bus = createEventBus();

    const first = await execute({ settlementId: settlement.id }, { bus });
    expect(first.distributed).toBe(true);

    const second = await execute({ settlementId: settlement.id }, { bus });
    expect(second.distributed).toBe(false);
    // Same amounts returned from Settlement row
    expect(second.driverCents).toBe(first.driverCents);

    // RevenueSplit count unchanged at 2
    const splits = await prisma.revenueSplit.findMany({ where: { settlementId: settlement.id } });
    expect(splits).toHaveLength(2);

    // DomainEvent count unchanged at 1
    const events = await prisma.domainEvent.findMany({
      where: { type: DomainEventType.REWARD_DISTRIBUTED, aggregateId: settlement.id },
    });
    expect(events).toHaveLength(1);
  });

  it("no-root: same fixed-fee split; rootDriverId=null, rootDriverCents=0", async () => {
    const totalCents = 10_000;
    const { settlement } = await seedSettlement("noroot", totalCents, { withRoot: false });

    const result = await execute({ settlementId: settlement.id });

    expect(result.distributed).toBe(true);
    expect(result.platformCents).toBe(PLATFORM_FEE_CENTS);
    expect(result.driverCents).toBe(totalCents - PLATFORM_FEE_CENTS);
    expect(result.rootDriverCents).toBe(0);
    expect(result.rootDriverId).toBeNull();

    const splits = await prisma.revenueSplit.findMany({
      where: { settlementId: settlement.id },
    });
    expect(splits).toHaveLength(2);

    const platformSplit = splits.find((s) => s.beneficiaryType === SplitBeneficiaryType.PLATFORM)!;
    expect(platformSplit.amountCents).toBe(PLATFORM_FEE_CENTS);
  });
});
