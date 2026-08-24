import bcrypt from "bcrypt";
import request from "supertest";

import { app } from "../src/app";
import { AuthSessionService } from "../src/domain/auth/AuthSessionService";
import { AuthTokenService } from "../src/domain/auth/AuthTokenService";
import { prisma } from "./setup";

let sequence = 0;
function tag() {
  sequence += 1;
  return `${Date.now()}-${sequence}`;
}

async function createPassenger(label: string) {
  const email = `rides-ownership-${label}-${tag()}@test.com`;
  const user = await prisma.user.create({
    data: {
      name: label,
      email,
      phone: `219${String(sequence).padStart(8, "0")}`,
      role: "PASSENGER",
      passwordHash: await bcrypt.hash("password", 4),
    },
  });
  const passenger = await prisma.passenger.create({
    data: {
      userId: user.id,
      referralCode: `rides-${tag()}`,
      publicSlug: `rides-${tag()}`,
    },
  });
  return { user, passenger };
}

async function createDriver(label: string) {
  const email = `rides-ownership-driver-${label}-${tag()}@test.com`;
  const user = await prisma.user.create({
    data: {
      name: label,
      email,
      phone: `219${String(sequence).padStart(8, "0")}`,
      role: "DRIVER",
      passwordHash: await bcrypt.hash("password", 4),
    },
  });
  const driver = await prisma.driver.create({
    data: {
      userId: user.id,
      isActive: true,
      experienceLevel: "INTERMEDIARIO",
      regions: ["ZN"],
    },
  });
  return { user, driver };
}

async function createRide(passengerId: string, origin: string, selectedDriverId?: string) {
  return prisma.rideRequest.create({
    data: {
      passengerId,
      origin,
      destination: `${origin} destination`,
      scheduledAt: new Date(),
      status: "COMPLETED",
      ...(selectedDriverId ? { selectedDriverId } : {}),
    },
  });
}

async function bearerFor(userId: string) {
  const session = await new AuthSessionService().createSession(userId);
  return new AuthTokenService().issueAccessToken({
    userId,
    sessionId: session.session.id,
  });
}

describe("Passenger ride ownership", () => {
  it("rejects anonymous and invalid-token ride detail reads", async () => {
    const passenger = await createPassenger("Passenger owner");
    const ride = await createRide(passenger.passenger.id, "Owner");

    const anonymous = await request(app).get(`/rides/${ride.id}`);
    const invalid = await request(app)
      .get(`/rides/${ride.id}`)
      .set("Authorization", "Bearer invalid-token");

    expect(anonymous.status).toBe(401);
    expect(invalid.status).toBe(401);
  });

  it("lists only rides belonging to the authenticated passenger", async () => {
    const passengerA = await createPassenger("Passenger A");
    const passengerB = await createPassenger("Passenger B");
    const rideA1 = await createRide(passengerA.passenger.id, "A1");
    const rideA2 = await createRide(passengerA.passenger.id, "A2");
    const rideB1 = await createRide(passengerB.passenger.id, "B1");
    const tokenA = await bearerFor(passengerA.user.id);

    const response = await request(app)
      .get("/rides")
      .set("Authorization", `Bearer ${tokenA}`);

    expect(response.status).toBe(200);
    expect(response.body.map((ride: { id: string }) => ride.id)).toEqual(
      expect.arrayContaining([rideA1.id, rideA2.id]),
    );
    expect(response.body).toHaveLength(2);
    expect(response.body.map((ride: { id: string }) => ride.id)).not.toContain(rideB1.id);
  });

  it("rejects a passenger reading another passenger's ride by known id", async () => {
    const passengerA = await createPassenger("Passenger A");
    const passengerB = await createPassenger("Passenger B");
    const rideB = await createRide(passengerB.passenger.id, "B1");
    const tokenA = await bearerFor(passengerA.user.id);

    const response = await request(app)
      .get(`/rides/${rideB.id}`)
      .set("Authorization", `Bearer ${tokenA}`);

    expect(response.status).toBe(404);
    expect(response.body).not.toHaveProperty("passenger");
    expect(response.body).not.toHaveProperty("origin", "B1");
  });

  it("requires Bearer auth for the passenger ride collection", async () => {
    const response = await request(app).get("/rides");
    expect(response.status).toBe(401);
  });

  it("rejects a valid User token that has no Passenger", async () => {
    const user = await prisma.user.create({
      data: {
        name: "Driver-shaped user",
        email: `rides-ownership-driver-${tag()}@test.com`,
        phone: `219${String(sequence).padStart(8, "0")}`,
        role: "DRIVER",
        passwordHash: await bcrypt.hash("password", 4),
      },
    });
    const token = await bearerFor(user.id);

    const response = await request(app)
      .get("/rides")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(401);
  });

  it("allows passenger B to read its own ride after passenger A is denied", async () => {
    const passengerA = await createPassenger("Passenger A");
    const passengerB = await createPassenger("Passenger B");
    const rideB = await createRide(passengerB.passenger.id, "B1");
    const tokenA = await bearerFor(passengerA.user.id);
    const tokenB = await bearerFor(passengerB.user.id);

    const denied = await request(app)
      .get(`/rides/${rideB.id}`)
      .set("Authorization", `Bearer ${tokenA}`);
    const allowed = await request(app)
      .get(`/rides/${rideB.id}`)
      .set("Authorization", `Bearer ${tokenB}`);

    expect(denied.status).toBe(404);
    expect(allowed.status).toBe(200);
    expect(allowed.body.id).toBe(rideB.id);
    expect(allowed.body.passengerId).toBe(passengerB.passenger.id);
  });

  it("allows only a related driver to read a selected ride", async () => {
    const passenger = await createPassenger("Passenger owner");
    const related = await createDriver("Related");
    const unrelated = await createDriver("Unrelated");
    const ride = await createRide(passenger.passenger.id, "Driver ride", related.driver.id);
    const relatedToken = await bearerFor(related.user.id);
    const unrelatedToken = await bearerFor(unrelated.user.id);

    const allowed = await request(app)
      .get(`/rides/${ride.id}`)
      .set("Authorization", `Bearer ${relatedToken}`);
    const denied = await request(app)
      .get(`/rides/${ride.id}`)
      .set("Authorization", `Bearer ${unrelatedToken}`);

    expect(allowed.status).toBe(200);
    expect(allowed.body.id).toBe(ride.id);
    expect(denied.status).toBe(404);
    expect(denied.body).not.toHaveProperty("origin", "Driver ride");
  });

  it("does not treat x-driver-id as identity or ownership", async () => {
    const passenger = await createPassenger("Passenger owner");
    const related = await createDriver("Related");
    const ride = await createRide(passenger.passenger.id, "Spoof target", related.driver.id);

    const response = await request(app)
      .get(`/rides/${ride.id}`)
      .set("x-driver-id", related.driver.id);

    expect(response.status).toBe(401);
  });
});
