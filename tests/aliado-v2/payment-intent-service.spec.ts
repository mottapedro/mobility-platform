import bcrypt from "bcrypt";
import {
  DomainEventType,
  PaymentStatus,
  RideStatus,
} from "../../src/shared/enums";
import { cleanTestData, prisma } from "../setup";
import { useRevenuePolicyFixture } from "../fixtures/revenue-policy.fixture";
import { createEventBus } from "../../src/domain/shared/events/EventBus";
import { InMemoryPixProvider } from "../../src/domain/payment/providers/InMemoryPixProvider";
import {
  createPaymentIntent,
  handlePixWebhook,
} from "../../src/domain/payment/PaymentIntentService";

useRevenuePolicyFixture(prisma, cleanTestData);

function createReadBarrier(participants: number) {
  let arrived = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  return async () => {
    arrived += 1;
    if (arrived === participants) release();
    await released;
  };
}

function describeRejection(reason: unknown) {
  const error = reason as { name?: unknown; code?: unknown; message?: unknown };
  return {
    name: String(error?.name ?? "unknown"),
    code: String(error?.code ?? "unknown"),
    message: String(error?.message ?? reason),
  };
}

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

async function makeRide(passengerId: string, driverId: string) {
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

describe("PaymentIntentService.createPaymentIntent", () => {
  it("creates a PaymentIntent in PENDING and fills QRCode via provider", async () => {
    const driver = await makeDriver("pi.create.driver@test.com");
    const passenger = await makePassenger("pi.create.passenger@test.com", null);
    const ride = await makeRide(passenger.id, driver.id);

    const intent = await createPaymentIntent({
      rideRequestId: ride.id,
      amountCents: 4500,
      provider: new InMemoryPixProvider(),
      bus: createEventBus(),
    });

    expect(intent.status).toBe(PaymentStatus.PENDING);
    expect(intent.amountCents).toBe(4500);
    expect(intent.externalId).toBe(`pix_${intent.id}`);
    expect(intent.qrCode).toContain("4500");
    expect(intent.qrCodeImage?.length ?? 0).toBeGreaterThan(0);
  });

  it("publishes PAYMENT_INTENT_CREATED then PIX_QRCODE_GENERATED", async () => {
    const driver = await makeDriver("pi.events.driver@test.com");
    const passenger = await makePassenger("pi.events.passenger@test.com", null);
    const ride = await makeRide(passenger.id, driver.id);

    const seen: DomainEventType[] = [];
    const bus = createEventBus();
    bus.subscribe(DomainEventType.PAYMENT_INTENT_CREATED, async () => {
      seen.push(DomainEventType.PAYMENT_INTENT_CREATED);
    });
    bus.subscribe(DomainEventType.PIX_QRCODE_GENERATED, async () => {
      seen.push(DomainEventType.PIX_QRCODE_GENERATED);
    });

    await createPaymentIntent({
      rideRequestId: ride.id,
      amountCents: 1000,
      provider: new InMemoryPixProvider(),
      bus,
    });

    expect(seen).toEqual([
      DomainEventType.PAYMENT_INTENT_CREATED,
      DomainEventType.PIX_QRCODE_GENERATED,
    ]);
  });

  it("is idempotent on rideRequestId — second call returns the same intent", async () => {
    const driver = await makeDriver("pi.idem.driver@test.com");
    const passenger = await makePassenger("pi.idem.passenger@test.com", null);
    const ride = await makeRide(passenger.id, driver.id);

    const provider = new InMemoryPixProvider();
    const a = await createPaymentIntent({
      rideRequestId: ride.id,
      amountCents: 2000,
      provider,
      bus: createEventBus(),
    });
    const b = await createPaymentIntent({
      rideRequestId: ride.id,
      amountCents: 9999,
      provider,
      bus: createEventBus(),
    });
    expect(a.id).toBe(b.id);
    expect(b.amountCents).toBe(2000);
  });

  it("rejects unknown rideRequestId", async () => {
    await expect(
      createPaymentIntent({
        rideRequestId: "00000000-0000-0000-0000-000000000000",
        amountCents: 1000,
        provider: new InMemoryPixProvider(),
        bus: createEventBus(),
      })
    ).rejects.toThrow();
  });
});

describe("PaymentIntentService.handlePixWebhook", () => {
  it("CONFIRMED → fires PAYMENT_CONFIRMED, RIDE_SETTLED, REWARD_DISTRIBUTED and sets Ride.status=PAID", async () => {
    const driver = await makeDriver("wh.confirm.driver@test.com");
    const root = await makeDriver("wh.confirm.root@test.com");
    const passenger = await makePassenger("wh.confirm.passenger@test.com", root.id);
    const ride = await makeRide(passenger.id, driver.id);

    const provider = new InMemoryPixProvider();
    const seen: DomainEventType[] = [];
    const bus = createEventBus();
    for (const t of [
      DomainEventType.PAYMENT_CONFIRMED,
      DomainEventType.RIDE_SETTLED,
      DomainEventType.REWARD_DISTRIBUTED,
    ]) {
      bus.subscribe(t, async () => { seen.push(t); });
    }

    const intent = await createPaymentIntent({
      rideRequestId: ride.id,
      amountCents: 10_000,
      provider,
      bus,
    });

    const result = await handlePixWebhook({
      externalId: intent.externalId!,
      status: "CONFIRMED",
      bus,
    });

    expect(result.status).toBe(PaymentStatus.CONFIRMED);
    expect(result.confirmedAt).toBeInstanceOf(Date);
    expect(seen).toEqual([
      DomainEventType.PAYMENT_CONFIRMED,
      DomainEventType.RIDE_SETTLED,
      DomainEventType.REWARD_DISTRIBUTED,
    ]);

    // Model B: payment status lives in PaymentIntent, ride stays COMPLETED
    const updatedRide = await prisma.rideRequest.findUnique({ where: { id: ride.id } });
    expect(updatedRide?.status).toBe(RideStatus.COMPLETED);
    const finalIntent = await prisma.paymentIntent.findUnique({ where: { rideRequestId: ride.id } });
    expect(finalIntent?.status).toBe(PaymentStatus.CONFIRMED);
  });

  it("is idempotent on duplicate CONFIRMED webhooks — only one Settlement", async () => {
    const driver = await makeDriver("wh.idem.driver@test.com");
    const passenger = await makePassenger("wh.idem.passenger@test.com", driver.id);
    const ride = await makeRide(passenger.id, driver.id);

    const provider = new InMemoryPixProvider();
    const intent = await createPaymentIntent({
      rideRequestId: ride.id,
      amountCents: 5000,
      provider,
      bus: createEventBus(),
    });

    await handlePixWebhook({ externalId: intent.externalId!, status: "CONFIRMED", bus: createEventBus() });
    await handlePixWebhook({ externalId: intent.externalId!, status: "CONFIRMED", bus: createEventBus() });

    const settlements = await prisma.settlement.findMany({ where: { paymentIntentId: intent.id } });
    expect(settlements).toHaveLength(1);
  });

  it("FAILED → fires PAYMENT_FAILED and does not settle", async () => {
    const driver = await makeDriver("wh.failed.driver@test.com");
    const passenger = await makePassenger("wh.failed.passenger@test.com", null);
    const ride = await makeRide(passenger.id, driver.id);

    const provider = new InMemoryPixProvider();
    const seen: DomainEventType[] = [];
    const bus = createEventBus();
    bus.subscribe(DomainEventType.PAYMENT_FAILED, async () => {
      seen.push(DomainEventType.PAYMENT_FAILED);
    });
    bus.subscribe(DomainEventType.RIDE_SETTLED, async () => {
      seen.push(DomainEventType.RIDE_SETTLED);
    });

    const intent = await createPaymentIntent({
      rideRequestId: ride.id,
      amountCents: 1000,
      provider,
      bus,
    });
    const result = await handlePixWebhook({
      externalId: intent.externalId!,
      status: "FAILED",
      failureReason: "insufficient funds",
      bus,
    });

    expect(result.status).toBe(PaymentStatus.FAILED);
    expect(result.failureReason).toBe("insufficient funds");
    expect(seen).toEqual([DomainEventType.PAYMENT_FAILED]);

    const settlements = await prisma.settlement.findMany({ where: { paymentIntentId: intent.id } });
    expect(settlements).toHaveLength(0);
  });

  it("keeps CONFIRMED terminal when a later FAILED webhook arrives", async () => {
    const driver = await makeDriver("wh.terminal.driver@test.com");
    const passenger = await makePassenger("wh.terminal.passenger@test.com", driver.id);
    const ride = await makeRide(passenger.id, driver.id);
    const bus = createEventBus();
    const intent = await createPaymentIntent({
      rideRequestId: ride.id,
      amountCents: 10_000,
      provider: new InMemoryPixProvider(),
      bus,
    });

    const confirmed = await handlePixWebhook({
      externalId: intent.externalId!,
      status: "CONFIRMED",
      bus,
    });
    const settlementBefore = await prisma.settlement.findUniqueOrThrow({
      where: { paymentIntentId: intent.id },
      include: { splits: { orderBy: { beneficiaryType: "asc" } } },
    });
    const eventCountBefore = await prisma.domainEvent.count({
      where: {
        type: { in: [
          DomainEventType.PAYMENT_CONFIRMED,
          DomainEventType.PAYMENT_FAILED,
          DomainEventType.RIDE_SETTLED,
          DomainEventType.REWARD_DISTRIBUTED,
        ] },
      },
    });

    const afterFailed = await handlePixWebhook({
      externalId: intent.externalId!,
      status: "FAILED",
      failureReason: "late provider failure",
      bus,
    });

    const persisted = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
    const settlementAfter = await prisma.settlement.findUniqueOrThrow({
      where: { paymentIntentId: intent.id },
      include: { splits: { orderBy: { beneficiaryType: "asc" } } },
    });
    const eventCountAfter = await prisma.domainEvent.count({
      where: {
        type: { in: [
          DomainEventType.PAYMENT_CONFIRMED,
          DomainEventType.PAYMENT_FAILED,
          DomainEventType.RIDE_SETTLED,
          DomainEventType.REWARD_DISTRIBUTED,
        ] },
      },
    });
    const persistedRide = await prisma.rideRequest.findUniqueOrThrow({ where: { id: ride.id } });

    expect(afterFailed.status).toBe(PaymentStatus.CONFIRMED);
    expect(persisted.status).toBe(PaymentStatus.CONFIRMED);
    expect(persisted.confirmedAt).toEqual(confirmed.confirmedAt);
    expect(persisted.failedAt).toBeNull();
    expect(persisted.failureReason).toBeNull();
    expect(settlementAfter).toEqual(settlementBefore);
    expect(eventCountAfter).toBe(eventCountBefore);
    expect(persistedRide.status).toBe(RideStatus.COMPLETED);
  });

  it("keeps FAILED unchanged when a later CONFIRMED webhook is not allowed by the matrix", async () => {
    const driver = await makeDriver("wh.failed-terminal.driver@test.com");
    const passenger = await makePassenger("wh.failed-terminal.passenger@test.com", null);
    const ride = await makeRide(passenger.id, driver.id);
    const bus = createEventBus();
    const intent = await createPaymentIntent({
      rideRequestId: ride.id,
      amountCents: 2_500,
      provider: new InMemoryPixProvider(),
      bus,
    });

    const failed = await handlePixWebhook({
      externalId: intent.externalId!,
      status: "FAILED",
      failureReason: "provider rejected",
      bus,
    });
    const afterConfirmed = await handlePixWebhook({
      externalId: intent.externalId!,
      status: "CONFIRMED",
      bus,
    });
    const persisted = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });

    expect(afterConfirmed.status).toBe(PaymentStatus.FAILED);
    expect(persisted.status).toBe(PaymentStatus.FAILED);
    expect(persisted.failedAt).toEqual(failed.failedAt);
    expect(persisted.confirmedAt).toBeNull();
    expect(await prisma.settlement.count({ where: { paymentIntentId: intent.id } })).toBe(0);
    expect(await prisma.domainEvent.count({
      where: { type: DomainEventType.PAYMENT_CONFIRMED, aggregateId: intent.id },
    })).toBe(0);
    expect((await prisma.rideRequest.findUniqueOrThrow({ where: { id: ride.id } })).status)
      .toBe(RideStatus.COMPLETED);
  });

  it("allows only one concurrent PENDING to CONFIRMED transition and one financial event chain", async () => {
    for (let iteration = 0; iteration < 10; iteration += 1) {
      const driver = await makeDriver(`wh.concurrent.driver-${iteration}@test.com`);
      const root = await makeDriver(`wh.concurrent.root-${iteration}@test.com`);
      const passenger = await makePassenger(`wh.concurrent.passenger-${iteration}@test.com`, root.id);
      const ride = await makeRide(passenger.id, driver.id);
      const intent = await createPaymentIntent({
        rideRequestId: ride.id,
        amountCents: 10_000,
        provider: new InMemoryPixProvider(),
        bus: createEventBus(),
      });
      const afterIntentRead = createReadBarrier(2);
      const seen = {
        [DomainEventType.PAYMENT_CONFIRMED]: 0,
        [DomainEventType.RIDE_SETTLED]: 0,
        [DomainEventType.REWARD_DISTRIBUTED]: 0,
      };
      const bus = createEventBus();
      for (const type of Object.keys(seen) as Array<keyof typeof seen>) {
        bus.subscribe(type, async () => { seen[type] += 1; });
      }

      const attempts = await Promise.allSettled([
        handlePixWebhook({ externalId: intent.externalId!, status: "CONFIRMED", bus, afterIntentRead }),
        handlePixWebhook({ externalId: intent.externalId!, status: "CONFIRMED", bus, afterIntentRead }),
      ]);
      const settlement = await prisma.settlement.findUnique({
        where: { paymentIntentId: intent.id },
        include: { splits: true },
      });
      const persistedEventCounts = {
        paymentConfirmed: await prisma.domainEvent.count({
          where: { type: DomainEventType.PAYMENT_CONFIRMED, aggregateId: intent.id },
        }),
        rideSettled: settlement === null ? 0 : await prisma.domainEvent.count({
          where: { type: DomainEventType.RIDE_SETTLED, aggregateId: settlement.id },
        }),
        rewardDistributed: settlement === null ? 0 : await prisma.domainEvent.count({
          where: { type: DomainEventType.REWARD_DISTRIBUTED, aggregateId: settlement.id },
        }),
      };

      expect({
        fulfilled: attempts.filter((attempt) => attempt.status === "fulfilled").length,
        rejected: attempts.filter((attempt) => attempt.status === "rejected").length,
        rejectedReasons: attempts.flatMap((attempt) =>
          attempt.status === "rejected" ? [describeRejection(attempt.reason)] : []),
        statuses: attempts.flatMap((attempt) =>
          attempt.status === "fulfilled" ? [attempt.value.status] : []),
        paymentIntentStatus: (await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status,
        settlementCount: await prisma.settlement.count({ where: { paymentIntentId: intent.id } }),
        splitCount: settlement?.splits.length ?? 0,
        persistedEventCounts,
        publishedEventCounts: seen,
        rideStatus: (await prisma.rideRequest.findUniqueOrThrow({ where: { id: ride.id } })).status,
      }).toEqual({
        fulfilled: 2,
        rejected: 0,
        rejectedReasons: [],
        statuses: [PaymentStatus.CONFIRMED, PaymentStatus.CONFIRMED],
        paymentIntentStatus: PaymentStatus.CONFIRMED,
        settlementCount: 1,
        splitCount: 3,
        persistedEventCounts: {
          paymentConfirmed: 1,
          rideSettled: 1,
          rewardDistributed: 1,
        },
        publishedEventCounts: {
          [DomainEventType.PAYMENT_CONFIRMED]: 1,
          [DomainEventType.RIDE_SETTLED]: 1,
          [DomainEventType.REWARD_DISTRIBUTED]: 1,
        },
        rideStatus: RideStatus.COMPLETED,
      });

      const replay = await handlePixWebhook({
        externalId: intent.externalId!,
        status: "CONFIRMED",
        bus,
      });
      expect(replay.status).toBe(PaymentStatus.CONFIRMED);
      expect(await prisma.settlement.count({ where: { paymentIntentId: intent.id } })).toBe(1);
      expect(await prisma.domainEvent.count({
        where: { type: DomainEventType.PAYMENT_CONFIRMED, aggregateId: intent.id },
      })).toBe(1);
    }
  }, 60_000);

  it("rejects unknown externalId", async () => {
    await expect(
      handlePixWebhook({ externalId: "pix_does_not_exist", status: "CONFIRMED", bus: createEventBus() })
    ).rejects.toThrow();
  });
});
