import bcrypt from "bcrypt";
import request from "supertest";
import {
  DomainEventType,
  PaymentStatus,
  RideStatus,
  SplitBeneficiaryType,
} from "../../src/shared/enums";
import { app } from "../../src/app";
import { CompleteRideUseCase } from "../../src/application/use-cases/CompleteRideUseCase";
import {
  createPaymentIntent,
  handlePixWebhook,
} from "../../src/domain/payment/PaymentIntentService";
import { InMemoryPixProvider } from "../../src/domain/payment/providers/InMemoryPixProvider";
import { createEventBus } from "../../src/domain/shared/events/EventBus";
import { RootOwnershipProjectionService } from "../../src/domain/ownership/RootOwnershipProjectionService";
import { SyncProjectionJob } from "../../src/domain/network/SyncProjectionJob";
import { cleanTestData, prisma } from "../setup";
import { useRevenuePolicyFixture } from "../fixtures/revenue-policy.fixture";

const revenuePolicyFixture = useRevenuePolicyFixture(prisma, cleanTestData);

let fixtureSequence = 0;

function nextTag(label: string): string {
  fixtureSequence += 1;
  return `${label}-${fixtureSequence}`;
}

async function makeDriver(label: string) {
  const tag = nextTag(label);
  const user = await prisma.user.create({
    data: {
      name: tag,
      email: `${tag}@test.com`,
      phone: `21${String(1_000_000_000 + fixtureSequence).slice(-9)}`,
      role: "DRIVER",
      passwordHash: await bcrypt.hash("x", 4),
    },
  });
  return prisma.driver.create({
    data: {
      userId: user.id,
      isActive: true,
      experienceLevel: "INTERMEDIARIO",
      regions: ["ZN"],
    },
  });
}

async function makePassenger(label: string, rootDriverId: string) {
  const tag = nextTag(label);
  const user = await prisma.user.create({
    data: {
      name: tag,
      email: `${tag}@test.com`,
      phone: `22${String(1_000_000_000 + fixtureSequence).slice(-9)}`,
      role: "PASSENGER",
      passwordHash: await bcrypt.hash("x", 4),
    },
  });
  return prisma.passenger.create({
    data: {
      userId: user.id,
      referralCode: `ref-${tag}`,
      publicSlug: `slug-${tag}`,
      rootDriverId,
    },
  });
}

async function makeScenario(label: string, status: RideStatus = RideStatus.IN_PROGRESS) {
  const root = await makeDriver(`${label}-root`);
  const driver = await makeDriver(`${label}-driver`);
  const passenger = await makePassenger(`${label}-passenger`, root.id);
  const ride = await prisma.rideRequest.create({
    data: {
      passengerId: passenger.id,
      selectedDriverId: driver.id,
      rootDriverId: root.id,
      origin: "A",
      destination: "B",
      scheduledAt: new Date(),
      status,
      priceEstimated: 100,
      priceOffered: 100,
    },
  });
  await prisma.ownershipSnapshot.create({
    data: {
      rideId: ride.id,
      ownerId: root.id,
      ownerType: "ROOT_DRIVER",
      resolutionSource: "economic-convergence-test",
    },
  });
  return { root, driver, passenger, ride };
}

async function makeIntent(rideRequestId: string) {
  return createPaymentIntent({
    rideRequestId,
    amountCents: 10_000,
    provider: new InMemoryPixProvider(),
    bus: createEventBus(),
  });
}

async function expectNoEconomics(rideRequestId: string) {
  expect(await prisma.settlement.count({ where: { rideRequestId } })).toBe(0);
  expect(await prisma.revenueSplit.count({
    where: { settlement: { rideRequestId } },
  })).toBe(0);
}

async function readEconomicSnapshot(rideRequestId: string) {
  const settlement = await prisma.settlement.findUniqueOrThrow({
    where: { rideRequestId },
    include: { splits: { orderBy: { beneficiaryType: "asc" } } },
  });
  return {
    settlementId: settlement.id,
    totalCents: settlement.totalCents,
    driverCents: settlement.driverCents,
    platformCents: settlement.platformCents,
    rootDriverCents: settlement.rootDriverCents,
    rootDriverId: settlement.rootDriverId,
    revenuePolicyId: settlement.revenuePolicyId,
    revenuePolicyVersion: settlement.revenuePolicyVersion,
    splits: settlement.splits.map((split) => ({
      beneficiaryType: split.beneficiaryType,
      beneficiaryDriverId: split.beneficiaryDriverId,
      amountCents: split.amountCents,
      percentBps: split.percentBps,
    })),
  };
}

function expectCanonicalV2(
  snapshot: Awaited<ReturnType<typeof readEconomicSnapshot>>,
  driverId: string,
  rootDriverId: string,
) {
  expect(snapshot).toMatchObject({
    totalCents: 10_000,
    driverCents: 9_263,
    platformCents: 250,
    rootDriverCents: 487,
    rootDriverId,
    revenuePolicyId: revenuePolicyFixture.policyId,
    revenuePolicyVersion: 1,
    splits: [
      {
        beneficiaryType: SplitBeneficiaryType.DRIVER,
        beneficiaryDriverId: driverId,
        amountCents: 9_263,
      },
      {
        beneficiaryType: SplitBeneficiaryType.PLATFORM,
        beneficiaryDriverId: null,
        amountCents: 250,
      },
      {
        beneficiaryType: SplitBeneficiaryType.ROOT_DRIVER,
        beneficiaryDriverId: rootDriverId,
        amountCents: 487,
      },
    ],
  });
  expect(snapshot.splits.reduce((sum, split) => sum + split.amountCents, 0)).toBe(10_000);
}

describe("Economic convergence: PaymentIntent CONFIRMED is the only settlement boundary", () => {
  it("completes a ride with a PENDING intent without settling or confirming payment", async () => {
    const scenario = await makeScenario("complete-pending");
    const intent = await makeIntent(scenario.ride.id);

    await new CompleteRideUseCase().execute({
      rideId: scenario.ride.id,
      driverId: scenario.driver.id,
    });

    expect((await prisma.rideRequest.findUniqueOrThrow({ where: { id: scenario.ride.id } })).status)
      .toBe(RideStatus.COMPLETED);
    const persistedIntent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(persistedIntent.status).toBe(PaymentStatus.PENDING);
    expect(persistedIntent.confirmedAt).toBeNull();
    await expectNoEconomics(scenario.ride.id);
  });

  it("completes through the lifecycle route without creating a synthetic PaymentIntent", async () => {
    const scenario = await makeScenario("complete-no-intent");

    const response = await request(app).post(`/rides/${scenario.ride.id}/lifecycle/complete`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: RideStatus.COMPLETED, finalized: true });
    expect(await prisma.paymentIntent.count({ where: { rideRequestId: scenario.ride.id } })).toBe(0);
    await expectNoEconomics(scenario.ride.id);
  });

  it("produces canonical V2 economics for COMPLETE then CONFIRM", async () => {
    const scenario = await makeScenario("complete-confirm");
    await new CompleteRideUseCase().execute({
      rideId: scenario.ride.id,
      driverId: scenario.driver.id,
    });
    await expectNoEconomics(scenario.ride.id);

    const intent = await makeIntent(scenario.ride.id);
    await handlePixWebhook({
      externalId: intent.externalId!,
      status: "CONFIRMED",
      bus: createEventBus(),
    });

    expectCanonicalV2(
      await readEconomicSnapshot(scenario.ride.id),
      scenario.driver.id,
      scenario.root.id,
    );
  });

  it("produces the same canonical economics for CONFIRM then COMPLETE", async () => {
    const scenario = await makeScenario("confirm-complete");
    const intent = await makeIntent(scenario.ride.id);

    await handlePixWebhook({
      externalId: intent.externalId!,
      status: "CONFIRMED",
      bus: createEventBus(),
    });
    expect((await prisma.rideRequest.findUniqueOrThrow({ where: { id: scenario.ride.id } })).status)
      .toBe(RideStatus.IN_PROGRESS);

    await new CompleteRideUseCase().execute({
      rideId: scenario.ride.id,
      driverId: scenario.driver.id,
    });

    expectCanonicalV2(
      await readEconomicSnapshot(scenario.ride.id),
      scenario.driver.id,
      scenario.root.id,
    );
  });

  it("keeps concurrent completion and confirmation on the V2 writer", async () => {
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const scenario = await makeScenario(`concurrent-${iteration}`);
      const intent = await makeIntent(scenario.ride.id);
      let signalIntentRead!: () => void;
      let releasePayment!: () => void;
      const intentRead = new Promise<void>((resolve) => { signalIntentRead = resolve; });
      const paymentReleased = new Promise<void>((resolve) => { releasePayment = resolve; });

      const confirmation = handlePixWebhook({
        externalId: intent.externalId!,
        status: "CONFIRMED",
        bus: createEventBus(),
        afterIntentRead: async () => {
          signalIntentRead();
          await paymentReleased;
        },
      });

      await intentRead;
      try {
        await new CompleteRideUseCase().execute({
          rideId: scenario.ride.id,
          driverId: scenario.driver.id,
        });
        await expectNoEconomics(scenario.ride.id);
      } finally {
        releasePayment();
      }
      await confirmation;

      expect(await prisma.settlement.count({ where: { rideRequestId: scenario.ride.id } })).toBe(1);
      expectCanonicalV2(
        await readEconomicSnapshot(scenario.ride.id),
        scenario.driver.id,
        scenario.root.id,
      );
    }
  });

  it("keeps completion and webhook retries economically idempotent", async () => {
    const scenario = await makeScenario("retry");
    const intent = await makeIntent(scenario.ride.id);

    const firstCompletion = await request(app).post(`/rides/${scenario.ride.id}/lifecycle/complete`);
    const secondCompletion = await request(app).post(`/rides/${scenario.ride.id}/lifecycle/complete`);
    expect(firstCompletion.body.finalized).toBe(true);
    expect(secondCompletion.body.finalized).toBe(false);
    await expectNoEconomics(scenario.ride.id);

    await handlePixWebhook({ externalId: intent.externalId!, status: "CONFIRMED", bus: createEventBus() });
    await handlePixWebhook({ externalId: intent.externalId!, status: "CONFIRMED", bus: createEventBus() });

    const snapshot = await readEconomicSnapshot(scenario.ride.id);
    expectCanonicalV2(snapshot, scenario.driver.id, scenario.root.id);
    expect(await prisma.settlement.count({ where: { rideRequestId: scenario.ride.id } })).toBe(1);
    expect(snapshot.splits).toHaveLength(3);
    expect(await prisma.domainEvent.count({
      where: { type: DomainEventType.PAYMENT_CONFIRMED, aggregateId: intent.id },
    })).toBe(1);
    expect(await prisma.domainEvent.count({
      where: { type: DomainEventType.RIDE_SETTLED, aggregateId: snapshot.settlementId },
    })).toBe(1);
    expect(await prisma.domainEvent.count({
      where: { type: DomainEventType.REWARD_DISTRIBUTED, aggregateId: snapshot.settlementId },
    })).toBe(1);
  });

  it("preserves the frozen V2 owner, policy and splits across ownership reconciliation", async () => {
    const scenario = await makeScenario("snapshot", RideStatus.COMPLETED);
    const intent = await makeIntent(scenario.ride.id);
    await handlePixWebhook({ externalId: intent.externalId!, status: "CONFIRMED", bus: createEventBus() });
    const before = await readEconomicSnapshot(scenario.ride.id);

    const newRoot = await makeDriver("snapshot-new-root");
    const gapChild = await makeDriver("snapshot-gap-child");
    await prisma.driver.update({
      where: { id: gapChild.id },
      data: { referredByDriverId: newRoot.id },
    });
    await prisma.driverReferral.create({
      data: {
        referrerDriverId: newRoot.id,
        referredDriverId: gapChild.id,
        level: 1,
        isDirect: true,
      },
    });
    await prisma.passenger.update({
      where: { id: scenario.passenger.id },
      data: { rootDriverId: newRoot.id },
    });
    await prisma.rideRequest.update({
      where: { id: scenario.ride.id },
      data: { rootDriverId: newRoot.id },
    });

    const warning = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const sync = await SyncProjectionJob.execute(prisma);
      expect(sync.repaired).toBeGreaterThanOrEqual(1);
    } finally {
      warning.mockRestore();
    }

    const after = await readEconomicSnapshot(scenario.ride.id);
    const audit = await RootOwnershipProjectionService.projectSettlementOwnership(
      before.settlementId,
      prisma,
    );
    expect(audit).toMatchObject({
      rootDriverId: scenario.root.id,
      expectedRootDriverId: newRoot.id,
      divergent: true,
    });
    expect(after).toEqual(before);
    expectCanonicalV2(after, scenario.driver.id, scenario.root.id);
  });
});
