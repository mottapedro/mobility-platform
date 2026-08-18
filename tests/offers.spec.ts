import request from "supertest";
import { app } from "../src/app";
import { prisma } from "./setup";
import { ExpireOffersService } from "../src/application/use-cases/ExpireOffersService";

describe("PATCH /offers/respond", () => {
  it("deve aceitar uma offer", async () => {
    const driver = await prisma.user.create({
      data: {
        name: "Driver",
        email: "driver@test.com",
        phone: "999",
        role: "DRIVER",
        driver: {
          create: {
            experienceLevel: "PROFISSIONAL",
            isActive: true,
            regions: ["ZN"],
          },
        },
      },
      include: { driver: true },
    });

    const passenger = await prisma.passenger.create({
      data: {
        referralCode: `p-offers-1-${Date.now()}`,
        publicSlug: `p-offers-1-${Date.now()}`,
        user: {
          create: {
            name: "Passageiro",
            email: `p-offers-1-${Date.now()}@test.com`,
            phone: "111",
            role: "PASSENGER",
          },
        },
      },
    });

    const ride = await prisma.rideRequest.create({
      data: {
        passengerId: passenger.id,
        origin: "A",
        destination: "B",
        scheduledAt: new Date(),
        status: "WAITING_DRIVER",
      },
    });

    const offer = await prisma.rideOffer.create({
      data: {
        rideRequestId: ride.id,
        driverId: driver.driver!.id,
        status: "PENDING",
        expiresAt: new Date(Date.now() + 100000),
      },
    });

    const res = await request(app)
      .patch(`/offers/${offer.id}/respond`)
      .send({ accept: true });

    expect(res.status).toBe(200);

    const updatedRide = await prisma.rideRequest.findUnique({
      where: { id: ride.id },
    });

    expect(updatedRide?.selectedDriverId).toBe(driver.driver!.id);
  });

  it("deve rejeitar uma offer", async () => {
    const driver = await prisma.user.create({
      data: {
        name: "Driver2",
        email: "driver2@test.com",
        phone: "999",
        role: "DRIVER",
        driver: {
          create: {
            experienceLevel: "PROFISSIONAL",
            isActive: true,
            regions: ["ZN"],
          },
        },
      },
      include: { driver: true },
    });

    const passenger = await prisma.passenger.create({
      data: {
        referralCode: `p-offers-2-${Date.now()}`,
        publicSlug: `p-offers-2-${Date.now()}`,
        user: {
          create: {
            name: "Passageiro2",
            email: `p-offers-2-${Date.now()}@test.com`,
            phone: "111",
            role: "PASSENGER",
          },
        },
      },
    });

    const ride = await prisma.rideRequest.create({
      data: {
        passengerId: passenger.id,
        origin: "A",
        destination: "B",
        scheduledAt: new Date(),
        status: "MATCHING",
      },
    });

    const offer = await prisma.rideOffer.create({
      data: {
        rideRequestId: ride.id,
        driverId: driver.driver!.id,
        status: "PENDING",
        expiresAt: new Date(Date.now() + 100000),
      },
    });

    const res = await request(app)
      .patch(`/offers/${offer.id}/respond`)
      .send({ accept: false });

    expect(res.status).toBe(200);

    const updatedOffer = await prisma.rideOffer.findUnique({
      where: { id: offer.id },
    });
    const updatedRide = await prisma.rideRequest.findUniqueOrThrow({
      where: { id: ride.id },
    });
    const pendingOffers = await prisma.rideOffer.count({
      where: { rideRequestId: ride.id, status: "PENDING" },
    });

    expect(updatedOffer?.status).toBe("REJECTED");
    expect(updatedRide.excludedDriverIds).toContain(driver.driver!.id);
    expect(pendingOffers).toBeLessThanOrEqual(1);
    if (pendingOffers === 0) {
      // Exact P2025 regression: no candidate is available, so the optional
      // recovery CAS must be idempotent and the endpoint must still return 200.
      expect(updatedRide.status).toBe("MATCHING");
      expect(updatedRide.currentDispatchStage).toBe("OWNER_RECOVERY");
    } else {
      // Other suites may leave protected bootstrap drivers in the shared DB.
      // A legitimate redispatch must expose the general-pool UX tier.
      expect(updatedRide.status).toBe("WAITING_GENERAL");
    }
  });

  it("does not accept an offer after the referral fallback already expired it", async () => {
    const referredDriver = await prisma.user.create({
      data: {
        name: "Race Driver",
        email: "race.driver@test.com",
        phone: "21777777777",
        role: "DRIVER",
        driver: {
          create: {
            experienceLevel: "PROFISSIONAL",
            isActive: true,
          },
        },
      },
      include: { driver: true },
    });

    const passenger = await prisma.passenger.create({
      data: {
        user: {
          create: {
            name: "Race Passenger",
            email: "race.passenger@test.com",
            phone: "21666666666",
            role: "PASSENGER",
          },
        },
        referredByDriver: {
          connect: { id: referredDriver.driver!.id },
        },
      },
    });

    const ride = await prisma.rideRequest.create({
      data: {
        passengerId: passenger.id,
        origin: "A",
        destination: "B",
        scheduledAt: new Date(Date.now() + 3_600_000),
        status: "WAITING_REFERRAL",
      },
    });

    const offer = await prisma.rideOffer.create({
      data: {
        rideRequestId: ride.id,
        driverId: referredDriver.driver!.id,
        status: "PENDING",
        expiresAt: new Date(Date.now() - 1_000),
      },
    });

    const expireOffers = new ExpireOffersService();
    await expireOffers.execute();

    const response = await request(app)
      .patch(`/offers/${offer.id}/respond`)
      .send({ accept: true });

    expect(response.status).toBe(410);

    const updatedRide = await prisma.rideRequest.findUniqueOrThrow({
      where: { id: ride.id },
    });

    expect(updatedRide.selectedDriverId).toBeNull();
    expect(updatedRide.status).not.toBe("ACCEPTED");
  });
});
