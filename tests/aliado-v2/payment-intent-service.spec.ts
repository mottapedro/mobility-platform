import bcrypt from "bcrypt";
import {
  DomainEventType,
  PaymentStatus,
  RideStatus,
} from "@prisma/client";
import { prisma } from "../setup";
import { createEventBus } from "../../src/domain/shared/events/EventBus";
import { InMemoryPixProvider } from "../../src/domain/payment/providers/InMemoryPixProvider";
import {
  createPaymentIntent,
  handlePixWebhook,
} from "../../src/domain/payment/PaymentIntentService";

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

    const updatedRide = await prisma.rideRequest.findUnique({ where: { id: ride.id } });
    expect(updatedRide?.status).toBe(RideStatus.PAID);
  });

  it("is idempotent on duplicate CONFIRMED webhooks — only one Settlement", async () => {
    const driver = await makeDriver("wh.idem.driver@test.com");
    const passenger = await makePassenger("wh.idem.passenger@test.com", null);
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

  it("rejects unknown externalId", async () => {
    await expect(
      handlePixWebhook({ externalId: "pix_does_not_exist", status: "CONFIRMED", bus: createEventBus() })
    ).rejects.toThrow();
  });
});
