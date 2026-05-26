import bcrypt from "bcrypt";
import { DomainEventType, RideStatus } from "../../src/shared/enums";
import { prisma } from "../setup";
import { createEventBus } from "../../src/domain/shared/events/EventBus";
import { execute as createOffer } from "../../src/application/services/CreateOfferService";

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

async function makeRide(passengerId: string) {
  return prisma.rideRequest.create({
    data: {
      passengerId,
      origin: "A",
      destination: "B",
      scheduledAt: new Date(),
      status: RideStatus.PENDING,
    },
  });
}

describe("CreateOfferService (application)", () => {
  it("creates a new RideOffer and reports created=true", async () => {
    const driver = await makeDriver("co.new.driver@test.com");
    const passenger = await makePassenger("co.new.passenger@test.com");
    const ride = await makeRide(passenger.id);

    const expiresAt = new Date(Date.now() + 60_000);
    const result = await createOffer({
      rideRequestId: ride.id,
      driverId: driver.id,
      expiresAt,
    });

    expect(result.created).toBe(true);
    expect(result.offer.rideRequestId).toBe(ride.id);
    expect(result.offer.driverId).toBe(driver.id);
    expect(result.offer.status).toBe("PENDING");
  });

  it("is idempotent: second call returns same offer with created=false", async () => {
    const driver = await makeDriver("co.idem.driver@test.com");
    const passenger = await makePassenger("co.idem.passenger@test.com");
    const ride = await makeRide(passenger.id);
    const expiresAt = new Date(Date.now() + 60_000);

    const first = await createOffer({
      rideRequestId: ride.id,
      driverId: driver.id,
      expiresAt,
    });
    const second = await createOffer({
      rideRequestId: ride.id,
      driverId: driver.id,
      expiresAt: new Date(Date.now() + 120_000),
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.offer.id).toBe(first.offer.id);
  });

  it("emits OFFER_CREATED only on first creation (not on idempotent re-call)", async () => {
    const driver = await makeDriver("co.evt.driver@test.com");
    const passenger = await makePassenger("co.evt.passenger@test.com");
    const ride = await makeRide(passenger.id);
    const expiresAt = new Date(Date.now() + 60_000);

    const bus = createEventBus();
    const received: string[] = [];
    bus.subscribe(DomainEventType.OFFER_CREATED, async (event) => {
      received.push(event.aggregateId);
    });

    const first = await createOffer(
      { rideRequestId: ride.id, driverId: driver.id, expiresAt },
      { bus }
    );
    await createOffer(
      { rideRequestId: ride.id, driverId: driver.id, expiresAt },
      { bus }
    );

    expect(received).toEqual([first.offer.id]);
    const persisted = await prisma.domainEvent.findMany({
      where: { type: DomainEventType.OFFER_CREATED, aggregateId: first.offer.id },
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0].aggregateType).toBe("RideOffer");
  });
});
