import request from "supertest";

import { app } from "../src/app";
import { prisma } from "./setup";

describe("Driver network read API", () => {
  it("returns network nodes by level with separated driver and passenger metrics", async () => {
    const rootUser = await prisma.user.create({
      data: {
        name: "Root Driver",
        email: "root-network@test.com",
        phone: "11999990100",
        role: "DRIVER",
      },
    });
    const rootDriver = await prisma.driver.create({
      data: {
        userId: rootUser.id,
        isActive: true,
        experienceLevel: "PROFISSIONAL",
        referralCode: "root-network",
      },
    });

    const driverL1Response = await request(app).post("/auth/register").send({
      name: "Driver L1",
      email: "driver-l1@test.com",
      password: "123456",
      role: "driver",
      phone: "11999990101",
      referralCode: rootDriver.referralCode,
    });
    expect(driverL1Response.status).toBe(201);
    const driverL1Id = driverL1Response.body.driverId as string;

    const driverL2Response = await request(app).post("/auth/register").send({
      name: "Driver L2",
      email: "driver-l2@test.com",
      password: "123456",
      role: "driver",
      phone: "11999990102",
      referralCode: driverL1Response.body.referralCode,
    });
    expect(driverL2Response.status).toBe(201);

    const passengerDirect = await request(app).post("/auth/register").send({
      name: "Passenger Direct",
      email: "passenger-direct@test.com",
      password: "123456",
      role: "passenger",
      phone: "11999990103",
      referralCode: rootDriver.referralCode,
    });
    expect(passengerDirect.status).toBe(201);

    const passengerInNetwork = await request(app).post("/auth/register").send({
      name: "Passenger L1",
      email: "passenger-l1@test.com",
      password: "123456",
      role: "passenger",
      phone: "11999990104",
      referralCode: driverL1Response.body.referralCode,
    });
    expect(passengerInNetwork.status).toBe(201);

    const response = await request(app).get(`/drivers/${rootDriver.id}/network`);

    expect(response.status).toBe(200);
    expect(response.body.driverId).toBe(rootDriver.id);
    expect(response.body.summary).toEqual({
      referredDrivers: {
        level1: 1,
        level2: 1,
        level3: 0,
        level4: 0,
        level5: 0,
        byLevel: {
          level1: 1,
          level2: 1,
          level3: 0,
          level4: 0,
          level5: 0,
        },
        total: 2,
        maxDepth: 5,
      },
      referredPassengers: {
        direct: 1,
        fromNetwork: 1,
        total: 2,
      },
    });

    expect(response.body.levels.level1).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          driverId: driverL1Id,
          name: "Driver L1",
          referralCode: driverL1Response.body.referralCode,
          referredPassengersCount: 1,
        }),
      ])
    );
  });
});
