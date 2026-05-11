import request from "supertest";

import { app } from "../src/app";
import { prisma } from "./setup";

describe("Public driver referral flow", () => {
  it("returns public driver data by referralCode", async () => {
    const user = await prisma.user.create({
      data: {
        name: "Pedro Publico",
        email: "pedro-public@test.com",
        phone: "11999990011",
        role: "DRIVER",
      },
    });

    const driver = await prisma.driver.create({
      data: {
        userId: user.id,
        isActive: true,
        experienceLevel: "PROFISSIONAL",
        referralCode: "pedro-publico",
        regions: {
          create: [{ region: "ZN" }],
        },
        vehicles: {
          create: [{ brand: "Chevrolet", model: "Onix", plate: "PUB1234", category: "CONFORTO" }],
        },
      },
    });

    const response = await request(app).get(`/public/drivers/${driver.referralCode}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      name: "Pedro Publico",
      referralCode: "pedro-publico",
      experienceLevel: "PROFISSIONAL",
      memberSince: expect.any(String),
      regions: ["ZN"],
      vehicles: [
        {
          brand: "Chevrolet",
          model: "Onix",
          category: "CONFORTO",
        },
      ],
    });
  });

  it("registers a passenger via referralCode and persists referredByDriverId", async () => {
    const referrerUser = await prisma.user.create({
      data: {
        name: "Referrer Passenger Flow",
        email: "ref-pass@test.com",
        phone: "11999990012",
        role: "DRIVER",
      },
    });

    const referrerDriver = await prisma.driver.create({
      data: {
        userId: referrerUser.id,
        isActive: true,
        experienceLevel: "INTERMEDIARIO",
        referralCode: "passenger-flow-code",
      },
    });

    const response = await request(app)
      .post("/auth/register")
      .send({
        name: "Passenger Referral",
        email: "passenger-referral@test.com",
        password: "123456",
        role: "passenger",
        phone: "11999990013",
        referralCode: "passenger-flow-code",
      });

    expect(response.status).toBe(201);
    expect(response.body.referredByDriverId).toBe(referrerDriver.id);

    const passenger = await prisma.passenger.findUnique({
      where: { id: response.body.passengerId },
    });

    expect(passenger?.referredByDriverId).toBe(referrerDriver.id);
  });

  it("registers a driver via referralCode and creates the referral chain", async () => {
    const referrerUser = await prisma.user.create({
      data: {
        name: "Referrer Driver Flow",
        email: "ref-driver@test.com",
        phone: "11999990014",
        role: "DRIVER",
      },
    });

    const referrerDriver = await prisma.driver.create({
      data: {
        userId: referrerUser.id,
        isActive: true,
        experienceLevel: "ELITE",
        referralCode: "driver-flow-code",
      },
    });

    const response = await request(app)
      .post("/auth/register")
      .send({
        name: "Driver Referral",
        email: "driver-referral@test.com",
        password: "123456",
        role: "driver",
        phone: "11999990015",
        referralCode: "driver-flow-code",
      });

    expect(response.status).toBe(201);
    expect(response.body.driverId).toBeDefined();
    expect(response.body.referralCode).toBeDefined();

    const referralEdge = await prisma.driverReferral.findFirst({
      where: {
        referrerDriverId: referrerDriver.id,
        referredDriverId: response.body.driverId,
      },
    });

    expect(referralEdge).not.toBeNull();
    expect(referralEdge?.level).toBe(1);
  });
});