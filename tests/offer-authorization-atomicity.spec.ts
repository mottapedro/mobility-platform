import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../src/app";
import { prisma } from "./setup";
import { RespondToRideOfferUseCase } from "../src/application/use-cases/RespondToRideOfferUseCase";

const PASSWORD = "123456";

async function createCurrentDemandRevision(ride: {
  id: string;
  origin: string;
  destination: string;
  scheduledAt: Date | null;
  originPlaceId: string | null;
  destinationPlaceId: string | null;
}) {
  return prisma.demandRevision.create({
    data: {
      rideRequestId: ride.id,
      sequence: 1,
      state: "CURRENT",
      origin: ride.origin,
      destination: ride.destination,
      scheduledAt: ride.scheduledAt,
      originPlaceId: ride.originPlaceId,
      destinationPlaceId: ride.destinationPlaceId,
    },
  });
}

async function createDriver(label: string) {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const user = await prisma.user.create({
    data: {
      name: `Offer ${label}`,
      email: `${suffix}@test.com`,
      phone: `219${Math.floor(Math.random() * 90000000 + 10000000)}`,
      role: "DRIVER",
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      driver: {
        create: { isActive: true, experienceLevel: "INTERMEDIARIO", regions: ["ZN"] },
      },
    },
    include: { driver: true },
  });
  return { user, driver: user.driver! };
}

async function createPassenger(label: string) {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const user = await prisma.user.create({
    data: {
      name: `Offer passenger ${label}`,
      email: `${suffix}@test.com`,
      phone: `118${Math.floor(Math.random() * 9000000 + 1000000)}`,
      role: "PASSENGER",
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      passenger: { create: { referralCode: `offer-${suffix}`, publicSlug: `offer-${suffix}` } },
    },
    include: { passenger: true },
  });
  return { user, passenger: user.passenger! };
}

async function tokenFor(email: string) {
  const response = await request(app).post("/auth/login").send({ email, password: PASSWORD });
  expect(response.status).toBe(200);
  return response.body.accessToken as string;
}

async function createOfferFixture() {
  const owner = await createDriver("owner");
  const other = await createDriver("other");
  const passenger = await createPassenger("fixture");
  const ride = await prisma.rideRequest.create({
    data: {
      passengerId: passenger.passenger.id,
      origin: "A",
      destination: "B",
      scheduledAt: new Date(Date.now() + 60_000),
      status: "WAITING_GENERAL",
    },
  });
  await createCurrentDemandRevision(ride);
  const offer = await prisma.rideOffer.create({
    data: {
      rideRequestId: ride.id,
      driverId: owner.driver.id,
      status: "PENDING",
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  return { owner, other, passenger, ride, offer };
}

describe("P0 RideOffer authorization", () => {
  it("requires Bearer, ignores x-driver-id, and scopes legacy reads to the owner", async () => {
    const fixture = await createOfferFixture();
    const ownerToken = await tokenFor(fixture.owner.user.email);
    const otherToken = await tokenFor(fixture.other.user.email);

    expect((await request(app).get(`/drivers/${fixture.owner.driver.id}/offers`)).status).toBe(401);
    expect(
      (await request(app).get(`/drivers/${fixture.owner.driver.id}/offers`).set("x-driver-id", fixture.owner.driver.id)).status,
    ).toBe(401);
    expect(
      (await request(app).get(`/drivers/${fixture.owner.driver.id}/offers`).set("Authorization", `Bearer ${ownerToken}`)).status,
    ).toBe(200);
    expect((await request(app).get("/drivers/me/offers").set("Authorization", `Bearer ${ownerToken}`)).status).toBe(200);
    expect(
      (await request(app).get(`/drivers/${fixture.owner.driver.id}/offers`).set("Authorization", `Bearer ${otherToken}`)).status,
    ).toBe(404);
  });

  it("requires the authenticated owner for both accept and reject", async () => {
    const fixture = await createOfferFixture();
    const ownerToken = await tokenFor(fixture.owner.user.email);
    const otherToken = await tokenFor(fixture.other.user.email);
    const passengerToken = await tokenFor(fixture.passenger.user.email);

    expect((await request(app).patch(`/offers/${fixture.offer.id}/respond`).send({ accept: true })).status).toBe(401);
    expect(
      (await request(app).patch(`/offers/${fixture.offer.id}/respond`).set("Authorization", `Bearer ${passengerToken}`).send({ accept: true })).status,
    ).toBe(401);
    expect(
      (await request(app).patch(`/offers/${fixture.offer.id}/respond`).set("Authorization", `Bearer ${otherToken}`).send({ accept: true })).status,
    ).toBe(404);
    expect(
      (await request(app).patch(`/offers/${fixture.offer.id}/respond`).set("Authorization", `Bearer ${otherToken}`).send({ accept: false })).status,
    ).toBe(404);
    expect(
      (await request(app).patch(`/offers/${fixture.offer.id}/respond`).set("Authorization", `Bearer ${ownerToken}`).send({ accept: true })).status,
    ).toBe(200);
  });

  it("allows the owner to reject a pending offer", async () => {
    const fixture = await createOfferFixture();
    const ownerToken = await tokenFor(fixture.owner.user.email);
    const response = await request(app)
      .patch(`/offers/${fixture.offer.id}/respond`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ accept: false });
    expect(response.status).toBe(200);
    expect((await prisma.rideOffer.findUnique({ where: { id: fixture.offer.id } }))?.status).toBe("REJECTED");
  });
});

describe("P0 RideOffer atomic acceptance", () => {
  it("permits exactly one winner when two drivers accept concurrently", async () => {
    const first = await createDriver("race-a");
    const passenger = await createPassenger("race");
    const ride = await prisma.rideRequest.create({
      data: {
        passengerId: passenger.passenger.id,
        origin: "A",
        destination: "B",
        scheduledAt: new Date(Date.now() + 60_000),
        status: "WAITING_GENERAL",
      },
    });
    await createCurrentDemandRevision(ride);
    const offer = await prisma.rideOffer.create({
      data: {
        rideRequestId: ride.id,
        driverId: first.driver.id,
        status: "PENDING",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const pending = await prisma.rideOffer.findMany({
      where: { rideRequestId: ride.id, status: "PENDING" },
      select: { id: true, driverId: true },
    });
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(offer.id);

    const results = await Promise.allSettled(
      [1, 2].map(() => new RespondToRideOfferUseCase().execute(offer.id, true, first.driver.id)),
    );
    const successes = results.filter((result) => result.status === "fulfilled");
    expect(successes).toHaveLength(1);

    const finalRide = await prisma.rideRequest.findUniqueOrThrow({ where: { id: ride.id } });
    const acceptedOffers = await prisma.rideOffer.count({ where: { rideRequestId: ride.id, status: "ACCEPTED" } });
    expect(finalRide.selectedDriverId).not.toBeNull();
    expect(acceptedOffers).toBe(1);
    expect(finalRide.selectedDriverId).toBe(first.driver.id);
  });
});
