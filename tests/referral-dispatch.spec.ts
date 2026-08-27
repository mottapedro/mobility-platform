import request from "supertest";
import { ExperienceLevel } from "@prisma/client";

import { app } from "../src/app";
import { prisma } from "./setup";
import { ExpireOffersService } from "../src/application/use-cases/ExpireOffersService";
import { SHORT_NOTICE_OFFER_WINDOW_MS } from "../src/domain/services/AcceptancePolicyEngine";

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

async function createOperationalBase(driverId: string) {
  return prisma.driverOperationalBase.create({
    data: {
      driverId,
      formattedAddress: "Base M - Barra da Tijuca",
      providerPlaceId: "ChIJ_referral_dispatch_base",
      latitude: -22.9068,
      longitude: -43.1729,
    },
  });
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

function confirmQuote(rideId: string) {
  return request(app).post(`/rides/${rideId}/confirm-quote`);
}

describe("Referral-first dispatch", () => {
  it("starts in WAITING_REFERRAL with one short-notice offer for the referred driver", async () => {
    const suffix = Date.now().toString();
    const referredDriver = await createDriver(`referred.start.${suffix}@test.com`);
    await createOperationalBase(referredDriver.id);
    await createDriver(`general.start.${suffix}@test.com`, "INICIANTE");
    const passenger = await createReferredPassenger(referredDriver.id);

    const response = await request(app)
      .post("/rides")
      .send({
        passengerId: passenger.id,
        origin: "Barra",
        destination: "Centro",
        originLat: -22.9068,
        originLng: -43.1729,
        destinationLat: -22.8833,
        destinationLng: -43.1072,
        scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
      });

    expect(response.status).toBe(201);
    expect(response.body.rideQuote?.status).toBe("QUOTED");

    const confirmation = await confirmQuote(response.body.ride.id);
    expect(confirmation.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 25));

    const ride = await prisma.rideRequest.findUnique({
      where: { id: response.body.ride.id },
      include: { offers: true },
    });

    expect(ride?.status).toBe("WAITING_REFERRAL");
    expect(ride?.offers).toHaveLength(1);
    expect(ride?.offers[0].driverId).toBe(referredDriver.id);

    const timeoutMs = ride!.offers[0].expiresAt.getTime() - ride!.offers[0].createdAt.getTime();
    expect(timeoutMs).toBeGreaterThanOrEqual(SHORT_NOTICE_OFFER_WINDOW_MS - 1_000);
    expect(timeoutMs).toBeLessThanOrEqual(SHORT_NOTICE_OFFER_WINDOW_MS + 1_000);
  });

  it("falls back to the general pool after the referred offer expires and never duplicates the referred offer", async () => {
    const suffix = Date.now().toString();
    const referredDriver = await createDriver(`referred.expire.${suffix}@test.com`);
    await createOperationalBase(referredDriver.id);
    await createDriver(`general.expire.${suffix}@test.com`, "ELITE");
    const passenger = await createReferredPassenger(referredDriver.id);

    const response = await request(app)
      .post("/rides")
      .send({
        passengerId: passenger.id,
        origin: "Copacabana",
        destination: "Centro",
        originLat: -22.9068,
        originLng: -43.1729,
        destinationLat: -22.8833,
        destinationLng: -43.1072,
        scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
      });

    expect(response.status).toBe(201);
    expect(response.body.rideQuote?.status).toBe("QUOTED");

    const confirmation = await confirmQuote(response.body.ride.id);
    expect(confirmation.status).toBe(200);

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

    expect(ride.status).toBe("WAITING_GENERAL");
    expect(ride.offers.filter((offer) => offer.driverId === referredDriver.id)).toHaveLength(1);
    expect(ride.offers.some((offer) => offer.driverId !== referredDriver.id)).toBe(true);
  });
});
