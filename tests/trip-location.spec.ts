import request from "supertest";
import { app } from "../src/app";
import { prisma } from "./setup";

async function makeDriver(email: string) {
  const u = await prisma.user.create({
    data: {
      name: email,
      email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "DRIVER",
    },
  });
  return prisma.driver.create({
    data: { userId: u.id, experienceLevel: "INTERMEDIARIO" },
  });
}

async function makePassenger(email: string) {
  const u = await prisma.user.create({
    data: {
      name: email,
      email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "PASSENGER",
    },
  });
  return prisma.passenger.create({ data: { userId: u.id } });
}

async function makeRide(passengerId: string) {
  return prisma.rideRequest.create({
    data: {
      passengerId,
      origin: "A",
      destination: "B",
      scheduledAt: new Date(),
      status: "ACCEPTED",
    },
  });
}

describe("GET /trips/:rideId/location", () => {
  it("returns 404 when the ride does not exist", async () => {
    const res = await request(app).get("/trips/nonexistent-ride-id/location");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("RideRequest not found");
  });

  it("returns 200 hasLocation=false when the ride exists but has no pings", async () => {
    const driver = await makeDriver(`trip.loc.noping.drv${Date.now()}@test.com`);
    const passenger = await makePassenger(`trip.loc.noping.psg${Date.now()}@test.com`);
    const ride = await makeRide(passenger.id);
    void driver;

    const res = await request(app).get(`/trips/${ride.id}/location`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasLocation: false, rideId: ride.id });
  });

  it("returns the single ping for the ride", async () => {
    const driver = await makeDriver(`trip.loc.one.drv${Date.now()}@test.com`);
    const passenger = await makePassenger(`trip.loc.one.psg${Date.now()}@test.com`);
    const ride = await makeRide(passenger.id);

    await prisma.driverLocationPing.create({
      data: {
        rideRequestId: ride.id,
        driverId: driver.id,
        lat: -22.9,
        lng: -43.2,
        recordedAt: new Date("2026-08-06T22:00:00.000Z"),
        source: "LIVE",
      },
    });

    const res = await request(app).get(`/trips/${ride.id}/location`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      hasLocation: true,
      rideId: ride.id,
      driverId: driver.id,
      lat: -22.9,
      lng: -43.2,
      source: "LIVE",
    });
    expect(res.body.recordedAt).toBe("2026-08-06T22:00:00.000Z");
    expect(typeof res.body.receivedAt).toBe("string");
  });

  it("returns the most recent ping when multiple exist", async () => {
    const driver = await makeDriver(`trip.loc.multi.drv${Date.now()}@test.com`);
    const passenger = await makePassenger(`trip.loc.multi.psg${Date.now()}@test.com`);
    const ride = await makeRide(passenger.id);

    await prisma.driverLocationPing.createMany({
      data: [
        { rideRequestId: ride.id, driverId: driver.id, lat: -22.9, lng: -43.2, recordedAt: new Date("2026-08-06T21:00:00.000Z"), source: "LIVE" },
        { rideRequestId: ride.id, driverId: driver.id, lat: -22.95, lng: -43.25, recordedAt: new Date("2026-08-06T22:00:00.000Z"), source: "LIVE" },
        { rideRequestId: ride.id, driverId: driver.id, lat: -23.0, lng: -43.3, recordedAt: new Date("2026-08-06T20:00:00.000Z"), source: "OFFLINE_CACHE" },
      ],
    });

    const res = await request(app).get(`/trips/${ride.id}/location`);
    expect(res.status).toBe(200);
    expect(res.body.hasLocation).toBe(true);
    expect(res.body.lat).toBe(-22.95);
    expect(res.body.lng).toBe(-43.25);
    expect(res.body.recordedAt).toBe("2026-08-06T22:00:00.000Z");
  });

  it("never leaks pings from another ride", async () => {
    const driver = await makeDriver(`trip.loc.iso.drv${Date.now()}@test.com`);
    const passengerA = await makePassenger(`trip.loc.iso.a${Date.now()}@test.com`);
    const passengerB = await makePassenger(`trip.loc.iso.b${Date.now()}@test.com`);
    const rideA = await makeRide(passengerA.id);
    const rideB = await makeRide(passengerB.id);

    await prisma.driverLocationPing.create({
      data: {
        rideRequestId: rideA.id,
        driverId: driver.id,
        lat: -11.0,
        lng: -22.0,
        recordedAt: new Date("2026-08-06T22:00:00.000Z"),
        source: "LIVE",
      },
    });

    const res = await request(app).get(`/trips/${rideB.id}/location`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasLocation: false, rideId: rideB.id });
  });
});
