import request from "supertest";
import { app } from "../src/app";
import { prisma } from "./setup";

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

    expect(updatedOffer?.status).toBe("REJECTED");
  });
});
