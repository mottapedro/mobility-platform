import request from "supertest";
import { app } from "../src/app";
import { prisma } from "./setup";

async function createDriver(email: string) {
  const user = await prisma.user.create({
    data: {
      name: email,
      email,
      phone: "21999990000",
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

  return user.driver!;
}

async function createPassenger(email: string, referredByDriverId?: string) {
  return prisma.passenger.create({
    data: {
      user: {
        create: {
          name: email,
          email,
          phone: "21999991111",
          role: "PASSENGER",
        },
      },
      ...(referredByDriverId
        ? { referredByDriver: { connect: { id: referredByDriverId } } }
        : {}),
    },
    include: { user: true },
  });
}

describe("GET /drivers/:id/network", () => {
  it("requires an authenticated driver header", async () => {
    const driver = await createDriver("driver-auth@test.com");

    const response = await request(app).get(`/drivers/${driver.id}/network`);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "Driver authentication required" });
  });

  it("forbids a driver from reading another driver network", async () => {
    const driver = await createDriver("driver-owner@test.com");
    const otherDriver = await createDriver("driver-other@test.com");

    const response = await request(app)
      .get(`/drivers/${driver.id}/network`)
      .set("x-driver-id", otherDriver.id);

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Driver cannot access another network" });
  });

  it("returns paginated linked passengers for the authenticated driver", async () => {
    const driver = await createDriver("driver-network@test.com");
    await createPassenger("network-1@test.com", driver.id);
    await createPassenger("network-2@test.com", driver.id);
    await createPassenger("network-3@test.com", driver.id);
    await createPassenger("outside-network@test.com");

    const response = await request(app)
      .get(`/drivers/${driver.id}/network?page=1&pageSize=2`)
      .set("x-driver-id", driver.id);

    expect(response.status).toBe(200);
    expect(response.body.totalPassengers).toBe(3);
    expect(response.body.page).toBe(1);
    expect(response.body.pageSize).toBe(2);
    expect(response.body.passengers).toHaveLength(2);
    expect(response.body.passengers[0]).toEqual(
      expect.objectContaining({
        referredByDriverId: driver.id,
        name: expect.any(String),
        email: expect.stringContaining("@test.com"),
        joinedAt: expect.any(String),
      })
    );
    expect(
      response.body.passengers.every((passenger: { referredByDriverId: string }) => passenger.referredByDriverId === driver.id)
    ).toBe(true);
  });
});