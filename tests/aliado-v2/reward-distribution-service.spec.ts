import bcrypt from "bcrypt";
import { PaymentStatus, RideStatus, SplitBeneficiaryType, DomainEventType } from "../../src/shared/enums";
import { prisma } from "../setup";
import { execute } from "../../src/application/services/RewardDistributionService";
import { createEventBus } from "../../src/domain/shared/events/EventBus";
import { SPLIT_BPS } from "../../src/domain/payment/RevenueSplitService";

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

  // Manually compute amounts mirroring computeRevenueSplit logic.
  const driverCents = Math.floor((totalCents * SPLIT_BPS.DRIVER) / 10_000);
  const platformBase = Math.floor((totalCents * SPLIT_BPS.PLATFORM) / 10_000);
  const remainder = totalCents - driverCents - platformBase;
  const platformCents = rootDriverId === null ? platformBase + remainder : platformBase;
  const rootDriverCents = rootDriverId === null ? 0 : remainder;

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
  it("creates 3 RevenueSplit rows and emits REWARD_DISTRIBUTED (with rootDriver)", async () => {
    const { driver, settlement } = await seedSettlement("happy", 10_000, { withRoot: true });
    const bus = createEventBus();

    const result = await execute({ settlementId: settlement.id }, { bus });

    expect(result.distributed).toBe(true);
    expect(result.driverCents).toBe(8_000);
    expect(result.platformCents).toBe(1_500);
    expect(result.rootDriverCents).toBe(500);
    expect(result.rootDriverId).toBe(driver.id);

    // 3 RevenueSplit rows created
    const splits = await prisma.revenueSplit.findMany({
      where: { settlementId: settlement.id },
      orderBy: { beneficiaryType: "asc" },
    });
    expect(splits).toHaveLength(3);

    const driverSplit = splits.find((s) => s.beneficiaryType === SplitBeneficiaryType.DRIVER)!;
    expect(driverSplit.beneficiaryDriverId).toBe(driver.id);
    expect(driverSplit.amountCents).toBe(8_000);
    expect(driverSplit.percentBps).toBe(SPLIT_BPS.DRIVER);

    const platformSplit = splits.find((s) => s.beneficiaryType === SplitBeneficiaryType.PLATFORM)!;
    expect(platformSplit.amountCents).toBe(1_500);
    expect(platformSplit.percentBps).toBe(SPLIT_BPS.PLATFORM);

    const rootSplit = splits.find((s) => s.beneficiaryType === SplitBeneficiaryType.ROOT_DRIVER)!;
    expect(rootSplit.beneficiaryDriverId).toBe(driver.id);
    expect(rootSplit.amountCents).toBe(500);
    expect(rootSplit.percentBps).toBe(SPLIT_BPS.ROOT_DRIVER);

    // REWARD_DISTRIBUTED event persisted
    const events = await prisma.domainEvent.findMany({
      where: { type: DomainEventType.REWARD_DISTRIBUTED, aggregateId: settlement.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ driverId: driver.id, driverCents: 8_000, rootDriverCents: 500 });
  });

  it("is idempotent — second call returns distributed:false, counts stay at 1", async () => {
    const { settlement } = await seedSettlement("idem", 5_000, { withRoot: true });
    const bus = createEventBus();

    const first = await execute({ settlementId: settlement.id }, { bus });
    expect(first.distributed).toBe(true);

    const second = await execute({ settlementId: settlement.id }, { bus });
    expect(second.distributed).toBe(false);
    // Same amounts returned from Settlement row
    expect(second.driverCents).toBe(first.driverCents);

    // RevenueSplit count unchanged at 3
    const splits = await prisma.revenueSplit.findMany({ where: { settlementId: settlement.id } });
    expect(splits).toHaveLength(3);

    // DomainEvent count unchanged at 1
    const events = await prisma.domainEvent.findMany({
      where: { type: DomainEventType.REWARD_DISTRIBUTED, aggregateId: settlement.id },
    });
    expect(events).toHaveLength(1);
  });

  it("no-root: platform gets 20% (15+5 rollup), ROOT_DRIVER split has percentBps=0", async () => {
    const { settlement } = await seedSettlement("noroot", 10_000, { withRoot: false });

    const result = await execute({ settlementId: settlement.id });

    expect(result.distributed).toBe(true);
    expect(result.driverCents).toBe(8_000);
    expect(result.platformCents).toBe(2_000); // 15% + 5% rollup
    expect(result.rootDriverCents).toBe(0);
    expect(result.rootDriverId).toBeNull();

    const splits = await prisma.revenueSplit.findMany({
      where: { settlementId: settlement.id },
    });
    expect(splits).toHaveLength(3);

    const platformSplit = splits.find((s) => s.beneficiaryType === SplitBeneficiaryType.PLATFORM)!;
    expect(platformSplit.amountCents).toBe(2_000);
    expect(platformSplit.percentBps).toBe(SPLIT_BPS.PLATFORM + SPLIT_BPS.ROOT_DRIVER);

    const rootSplit = splits.find((s) => s.beneficiaryType === SplitBeneficiaryType.ROOT_DRIVER)!;
    expect(rootSplit.amountCents).toBe(0);
    expect(rootSplit.percentBps).toBe(0);
    expect(rootSplit.beneficiaryDriverId).toBeNull();
  });
});
