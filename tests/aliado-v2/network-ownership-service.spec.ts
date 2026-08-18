import bcrypt from "bcrypt";
import { ActorType, RideStatus } from "../../src/shared/enums";
import { prisma } from "../setup";
import { recordRelationship } from "../../src/domain/referral-network/ReferralRelationshipService";
import { getOwnershipMetrics } from "../../src/domain/referral-network/NetworkOwnershipService";

async function makeDriver(email: string) {
  const u = await prisma.user.create({
    data: {
      name: email, email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "DRIVER",
      passwordHash: await bcrypt.hash("x", 4),
    },
  });
  return prisma.driver.create({
    data: { userId: u.id, isActive: true, experienceLevel: "INTERMEDIARIO", regions: ["ZN"] },
  });
}

async function makePassenger(email: string, rootDriverId: string) {
  const u = await prisma.user.create({
    data: {
      name: email, email,
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
      rootDriverId,
    },
  });
}

async function makeRide(
  passengerId: string,
  rootDriverId: string,
  status: RideStatus,
  ageMs = 0,
  selectedDriverId: string | null = null
) {
  return prisma.rideRequest.create({
    data: {
      passengerId,
      origin: "A", destination: "B",
      scheduledAt: new Date(Date.now() - ageMs),
      status,
      rootDriverId,
      selectedDriverId,
    },
  });
}

async function settleRide(
  rideRequestId: string,
  rootDriverId: string,
  settledAt = new Date()
) {
  const intent = await prisma.paymentIntent.create({
    data: {
      rideRequestId,
      amountCents: 10000,
      method: "PIX",
      status: "CONFIRMED",
      externalId: `ext-${rideRequestId}`,
    },
  });
  return prisma.settlement.create({
    data: {
      paymentIntentId: intent.id,
      rideRequestId,
      totalCents: 10000,
      driverCents: 8000,
      platformCents: 1500,
      rootDriverCents: 500,
      rootDriverId,
      settledAt,
    },
  });
}

describe("NetworkOwnershipService.getOwnershipMetrics", () => {
  it("returns zeroed metrics for a driver with empty network", async () => {
    const d = await makeDriver("own.empty@test.com");
    const m = await getOwnershipMetrics(d.id);
    expect(m).toMatchObject({
      driverId: d.id,
      windowDays: 30,
      directDrivers: 0,
      totalDriversInTree: 0,
      directPassengers: 0,
      totalPassengersInTree: 0,
      completedRidesAttributedToTree: 0,
      settledRevenueShareCents: 0,
      retentionRate: 0,
    });
  });

  it("counts direct drivers and direct passengers from ReferralRelationship", async () => {
    const root = await makeDriver("own.directs.root@test.com");
    const d2 = await makeDriver("own.directs.d2@test.com");
    const d3 = await makeDriver("own.directs.d3@test.com");
    await recordRelationship({
      inviterActorType: ActorType.DRIVER, inviterId: root.id,
      invitedActorType: ActorType.DRIVER, invitedId: d2.id,
    });
    await recordRelationship({
      inviterActorType: ActorType.DRIVER, inviterId: root.id,
      invitedActorType: ActorType.DRIVER, invitedId: d3.id,
    });
    const p1 = await makePassenger("own.directs.p1@test.com", root.id);
    await recordRelationship({
      inviterActorType: ActorType.DRIVER, inviterId: root.id,
      invitedActorType: ActorType.PASSENGER, invitedId: p1.id,
    });

    const m = await getOwnershipMetrics(root.id);
    expect(m.directDrivers).toBe(2);
    expect(m.totalDriversInTree).toBe(2);
    expect(m.directPassengers).toBe(1);
    expect(m.totalPassengersInTree).toBe(1);
  });

  it("counts indirect passengers (P→P chain) via Passenger.rootDriverId", async () => {
    const root = await makeDriver("own.tree.root@test.com");
    const p1 = await makePassenger("own.tree.p1@test.com", root.id);
    const p2 = await makePassenger("own.tree.p2@test.com", root.id);
    await recordRelationship({
      inviterActorType: ActorType.DRIVER, inviterId: root.id,
      invitedActorType: ActorType.PASSENGER, invitedId: p1.id,
    });
    await recordRelationship({
      inviterActorType: ActorType.PASSENGER, inviterId: p1.id,
      invitedActorType: ActorType.PASSENGER, invitedId: p2.id,
    });

    const m = await getOwnershipMetrics(root.id);
    expect(m.directPassengers).toBe(1);
    expect(m.totalPassengersInTree).toBe(2);
  });

  it("counts settlements attributed to the tree in the 30d window", async () => {
    const root = await makeDriver("own.rides.root@test.com");
    const p = await makePassenger("own.rides.p@test.com", root.id);
    const completed = await makeRide(p.id, root.id, RideStatus.COMPLETED, 0, root.id);
    const paid = await makeRide(p.id, root.id, RideStatus.PAID, 0, root.id);
    await makeRide(p.id, root.id, RideStatus.PENDING); // ignored
    const old = await makeRide(
      p.id,
      root.id,
      RideStatus.COMPLETED,
      1000 * 60 * 60 * 24 * 40,
      root.id
    );
    await settleRide(completed.id, root.id);
    await settleRide(paid.id, root.id);
    await settleRide(old.id, root.id, new Date(Date.now() - 1000 * 60 * 60 * 24 * 40));

    const m = await getOwnershipMetrics(root.id);
    expect(m.completedRidesAttributedToTree).toBe(2);
  });

  it("sums rootDriverCents from settlements attributed to the driver's tree", async () => {
    const root = await makeDriver("own.rev.root@test.com");
    const selectedDriver = await makeDriver("own.rev.selected@test.com");
    const p = await makePassenger("own.rev.p@test.com", root.id);
    const ride = await makeRide(p.id, root.id, RideStatus.PAID, 0, selectedDriver.id);
    await settleRide(ride.id, root.id);

    const m = await getOwnershipMetrics(root.id);
    expect(m.settledRevenueShareCents).toBe(500);
  });

  it("computes retentionRate = passengersWith2PlusRides / passengersWith1PlusRides", async () => {
    const root = await makeDriver("own.ret.root@test.com");
    const p1 = await makePassenger("own.ret.p1@test.com", root.id);
    const p2 = await makePassenger("own.ret.p2@test.com", root.id);
    const p1Ride1 = await makeRide(p1.id, root.id, RideStatus.COMPLETED, 0, root.id);
    const p1Ride2 = await makeRide(p1.id, root.id, RideStatus.COMPLETED, 0, root.id);
    const p2Ride = await makeRide(p2.id, root.id, RideStatus.COMPLETED, 0, root.id);
    await settleRide(p1Ride1.id, root.id);
    await settleRide(p1Ride2.id, root.id);
    await settleRide(p2Ride.id, root.id);

    const m = await getOwnershipMetrics(root.id);
    expect(m.retentionRate).toBeCloseTo(0.5, 5);
  });
});
