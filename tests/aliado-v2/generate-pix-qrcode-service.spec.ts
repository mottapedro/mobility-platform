import bcrypt from "bcrypt";
import {
  DomainEventType,
  PaymentStatus,
  RideStatus,
} from "../../src/shared/enums";
import { prisma } from "../setup";
import { createEventBus } from "../../src/domain/shared/events/EventBus";
import { InMemoryPixProvider } from "../../src/domain/payment/providers/InMemoryPixProvider";
import { execute as generatePixQrCode } from "../../src/application/services/GeneratePixQrCodeService";

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

async function makePassenger(email: string) {
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

describe("GeneratePixQrCodeService (application)", () => {
  it("creates a PaymentIntent in PENDING and returns the QR code surface", async () => {
    const driver = await makeDriver("gpq.create.driver@test.com");
    const passenger = await makePassenger("gpq.create.passenger@test.com");
    const ride = await makeRide(passenger.id, driver.id);

    const result = await generatePixQrCode(
      { rideRequestId: ride.id, amountCents: 5500 },
      { provider: new InMemoryPixProvider(), bus: createEventBus() }
    );

    expect(result.intent.status).toBe(PaymentStatus.PENDING);
    expect(result.intent.amountCents).toBe(5500);
    expect(result.externalId).toBe(`pix_${result.intent.id}`);
    expect(result.qrCode).toContain("5500");
    expect((result.qrCodeImage?.length ?? 0)).toBeGreaterThan(0);
  });

  it("is idempotent on rideRequestId (no duplicate intents, no duplicate events)", async () => {
    const driver = await makeDriver("gpq.idem.driver@test.com");
    const passenger = await makePassenger("gpq.idem.passenger@test.com");
    const ride = await makeRide(passenger.id, driver.id);

    const bus = createEventBus();
    let intentCreated = 0;
    bus.subscribe(DomainEventType.PAYMENT_INTENT_CREATED, async () => {
      intentCreated += 1;
    });

    const first = await generatePixQrCode(
      { rideRequestId: ride.id, amountCents: 1000 },
      { provider: new InMemoryPixProvider(), bus }
    );
    const second = await generatePixQrCode(
      { rideRequestId: ride.id, amountCents: 1000 },
      { provider: new InMemoryPixProvider(), bus }
    );

    expect(second.intent.id).toBe(first.intent.id);
    expect(intentCreated).toBe(1);

    const count = await prisma.paymentIntent.count({
      where: { rideRequestId: ride.id },
    });
    expect(count).toBe(1);
  });

  it("publishes PAYMENT_INTENT_CREATED then PIX_QRCODE_GENERATED in order", async () => {
    const driver = await makeDriver("gpq.evt.driver@test.com");
    const passenger = await makePassenger("gpq.evt.passenger@test.com");
    const ride = await makeRide(passenger.id, driver.id);

    const seen: DomainEventType[] = [];
    const bus = createEventBus();
    bus.subscribe(DomainEventType.PAYMENT_INTENT_CREATED, async () => {
      seen.push(DomainEventType.PAYMENT_INTENT_CREATED);
    });
    bus.subscribe(DomainEventType.PIX_QRCODE_GENERATED, async () => {
      seen.push(DomainEventType.PIX_QRCODE_GENERATED);
    });

    await generatePixQrCode(
      { rideRequestId: ride.id, amountCents: 800 },
      { provider: new InMemoryPixProvider(), bus }
    );

    expect(seen).toEqual([
      DomainEventType.PAYMENT_INTENT_CREATED,
      DomainEventType.PIX_QRCODE_GENERATED,
    ]);
  });

  it("rejects non-positive amountCents", async () => {
    const driver = await makeDriver("gpq.bad.driver@test.com");
    const passenger = await makePassenger("gpq.bad.passenger@test.com");
    const ride = await makeRide(passenger.id, driver.id);

    await expect(
      generatePixQrCode(
        { rideRequestId: ride.id, amountCents: 0 },
        { provider: new InMemoryPixProvider(), bus: createEventBus() }
      )
    ).rejects.toThrow(/amountCents/);
  });
});
