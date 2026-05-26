import bcrypt from "bcrypt";
import { DomainEventType, RideStatus } from "../../src/shared/enums";
import { prisma } from "../setup";
import { createEventBus } from "../../src/domain/shared/events/EventBus";
import { execute as finalizeRide } from "../../src/application/services/FinalizeRideService";

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

async function makeRideInProgress(passengerId: string, driverId: string) {
  return prisma.rideRequest.create({
    data: {
      passengerId,
      selectedDriverId: driverId,
      origin: "A",
      destination: "B",
      scheduledAt: new Date(),
      status: RideStatus.IN_PROGRESS,
    },
  });
}

describe("FinalizeRideService (application)", () => {
  it("finalizes an IN_PROGRESS ride to COMPLETED and emits RIDE_FINALIZED", async () => {
    const driver = await makeDriver("fr.basic.driver@test.com");
    const passenger = await makePassenger("fr.basic.passenger@test.com");
    const ride = await makeRideInProgress(passenger.id, driver.id);

    const bus = createEventBus();
    const received: string[] = [];
    bus.subscribe(DomainEventType.RIDE_FINALIZED, async (event) => {
      received.push(event.aggregateId);
    });

    const result = await finalizeRide({ rideRequestId: ride.id }, { bus });

    expect(result.finalized).toBe(true);
    expect(result.ride.status).toBe(RideStatus.COMPLETED);
    expect(received).toEqual([ride.id]);

    const persisted = await prisma.domainEvent.findMany({
      where: { type: DomainEventType.RIDE_FINALIZED, aggregateId: ride.id },
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0].aggregateType).toBe("RideRequest");
  });

  it("is idempotent: second call returns finalized=false and does not duplicate the event", async () => {
    const driver = await makeDriver("fr.idem.driver@test.com");
    const passenger = await makePassenger("fr.idem.passenger@test.com");
    const ride = await makeRideInProgress(passenger.id, driver.id);

    const bus = createEventBus();
    const received: string[] = [];
    bus.subscribe(DomainEventType.RIDE_FINALIZED, async (event) => {
      received.push(event.aggregateId);
    });

    const first = await finalizeRide({ rideRequestId: ride.id }, { bus });
    const second = await finalizeRide({ rideRequestId: ride.id }, { bus });

    expect(first.finalized).toBe(true);
    expect(second.finalized).toBe(false);
    expect(second.ride.id).toBe(first.ride.id);
    expect(second.ride.status).toBe(RideStatus.COMPLETED);
    expect(received).toEqual([ride.id]);

    const persisted = await prisma.domainEvent.findMany({
      where: { type: DomainEventType.RIDE_FINALIZED, aggregateId: ride.id },
    });
    expect(persisted).toHaveLength(1);
  });

  it("captures optional metrics (distanceKm, durationMin, finalPriceCents)", async () => {
    const driver = await makeDriver("fr.metrics.driver@test.com");
    const passenger = await makePassenger("fr.metrics.passenger@test.com");
    const ride = await makeRideInProgress(passenger.id, driver.id);

    const result = await finalizeRide({
      rideRequestId: ride.id,
      distanceKm: 12.5,
      durationMin: 35,
      finalPriceCents: 4250,
    });

    expect(result.finalized).toBe(true);
    expect(result.ride.distanceKm).toBeCloseTo(12.5);
    expect(result.ride.durationMin).toBe(35);
    expect(Number(result.ride.priceOffered)).toBeCloseTo(42.5);
  });

  it("throws with 'RideLifecycle:' prefix when source status is invalid (e.g. PENDING)", async () => {
    const passenger = await makePassenger("fr.invalid.passenger@test.com");
    const ride = await prisma.rideRequest.create({
      data: {
        passengerId: passenger.id,
        origin: "A",
        destination: "B",
        scheduledAt: new Date(),
        status: RideStatus.PENDING,
      },
    });

    await expect(finalizeRide({ rideRequestId: ride.id })).rejects.toThrow(
      /^RideLifecycle: cannot finalize ride .* from status=PENDING/
    );

    const reloaded = await prisma.rideRequest.findUnique({ where: { id: ride.id } });
    expect(reloaded?.status).toBe(RideStatus.PENDING);
  });
});
