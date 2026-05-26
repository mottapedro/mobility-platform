import request from "supertest";
import { ExperienceLevel } from "@prisma/client";

import { app } from "../src/app";
import { prisma } from "./setup";
import { ExpireOffersService } from "../src/application/use-cases/ExpireOffersService";

async function createDriver(email: string, experienceLevel: ExperienceLevel = "PROFISSIONAL") {
  const user = await prisma.user.create({
    data: {
      name: email,
      email,
      phone: "21999999999",
      role: "DRIVER",
      driver: {
        create: {
          experienceLevel,
          isActive: true,
        },
      },
    },
    include: { driver: true },
  });

  return user.driver!;
}

async function createReferredPassenger(referredByDriverId: string) {
  const suffix = Date.now().toString();
  const user = await prisma.user.create({
    data: {
      name: "Passenger Ref",
      email: `passenger.${suffix}@test.com`,
      phone: `21888${suffix.slice(-6)}`,
      role: "PASSENGER",
    },
  });

  return prisma.passenger.create({
    data: {
      user: {
        connect: { id: user.id },
      },
      referredByDriver: {
        connect: { id: referredByDriverId },
      },
    },
  });
}

describe("Referral-first dispatch", () => {
  it("starts in WAITING_REFERRAL with exactly one 30s offer for the referred driver", async () => {
    const suffix = Date.now().toString();
    const referredDriver = await createDriver(`referred.start.${suffix}@test.com`);
    await createDriver(`general.start.${suffix}@test.com`, "INICIANTE");
    const passenger = await createReferredPassenger(referredDriver.id);

    const response = await request(app)
      .post("/rides")
      .send({
        passengerId: passenger.id,
        origin: "Barra",
        destination: "Centro",
        scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
      });

    expect(response.status).toBe(201);

    await new Promise((resolve) => setTimeout(resolve, 25));

    const ride = await prisma.rideRequest.findUnique({
      where: { id: response.body.ride.id },
      include: { offers: true },
    });

    expect(ride?.status).toBe("WAITING_REFERRAL");
    expect(ride?.offers).toHaveLength(1);
    expect(ride?.offers[0].driverId).toBe(referredDriver.id);

    const timeoutMs = ride!.offers[0].expiresAt.getTime() - ride!.offers[0].createdAt.getTime();
    expect(timeoutMs).toBeGreaterThanOrEqual(29_000);
    expect(timeoutMs).toBeLessThanOrEqual(31_000);
  });

  it("falls back to the general pool after the referred offer expires and never duplicates the referred offer", async () => {
    const suffix = Date.now().toString();
    const referredDriver = await createDriver(`referred.expire.${suffix}@test.com`);
    const generalDriver = await createDriver(`general.expire.${suffix}@test.com`, "ELITE");
    const passenger = await createReferredPassenger(referredDriver.id);

    const response = await request(app)
      .post("/rides")
      .send({
        passengerId: passenger.id,
        origin: "Copacabana",
        destination: "Centro",
        scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
      });

    expect(response.status).toBe(201);

    await new Promise((resolve) => setTimeout(resolve, 25));

    const initialOffer = await prisma.rideOffer.findFirstOrThrow({
      where: { rideRequestId: response.body.ride.id, driverId: referredDriver.id },
    });

    await prisma.rideOffer.update({
      where: { id: initialOffer.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const expireOffers = new ExpireOffersService();
    await expireOffers.execute();
    await expireOffers.execute();

    const ride = await prisma.rideRequest.findUniqueOrThrow({
      where: { id: response.body.ride.id },
      include: { offers: { orderBy: { createdAt: "asc" } } },
    });

    expect(ride.status).toBe("MATCHING");
    expect(ride.offers.filter((offer) => offer.driverId === referredDriver.id)).toHaveLength(1);
    expect(ride.offers.some((offer) => offer.driverId === generalDriver.id)).toBe(true);
  });
});