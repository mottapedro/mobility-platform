import bcrypt from "bcrypt";
import { prisma } from "./setup";
import { runBootstrapNetwork } from "../prisma/seeds/bootstrap-network";
import request from "supertest";
import { app } from "../src/app";

describe("runBootstrapNetwork", () => {
  it("preserves existing live driver data and only adds missing regions", async () => {
    // Clean up any real seed driver that may have persisted from a previous run
    const existing = await prisma.driver.findUnique({
      where: { referralCode: "pedro-paulo-motta-zn" },
    });

    if (existing) {
      await prisma.driver.updateMany({
        where: { referredByDriverId: existing.id },
        data: { referredByDriverId: null },
      });

      await prisma.driverReferral.deleteMany({
        where: {
          OR: [
            { referrerDriverId: existing.id },
            { referredDriverId: existing.id },
          ],
        },
      });

      await prisma.rideOffer.deleteMany({
        where: { driverId: existing.id },
      });

      await prisma.vehicle.deleteMany({
        where: { driverId: existing.id },
      });

      await prisma.driver.delete({
        where: { id: existing.id },
      });

      await prisma.user.deleteMany({
        where: { id: existing.userId },
      });
    }

    // Pre-create a driver whose referralCode matches the first seed entry
    const existingUser = await prisma.user.create({
      data: {
        name: "Pedro Paulo Motta",
        email: "pedro-preserve@test.com",
        phone: "21900009999",
        role: "DRIVER",
        passwordHash: "live-hash",
      },
    });

    const existingDriver = await prisma.driver.create({
      data: {
        userId: existingUser.id,
        isActive: true,
        experienceLevel: "ELITE",
        referralCode: "pedro-paulo-motta-zn",
        regions: [],
      },
    });

    await runBootstrapNetwork(prisma);

    const reloadedUser = await prisma.user.findUniqueOrThrow({
      where: { id: existingUser.id },
    });

    const reloadedDriver = await prisma.driver.findUniqueOrThrow({
      where: { id: existingDriver.id },
    });

    // Live credentials must NOT be overwritten
    expect(reloadedUser.phone).toBe("21900009999");
    expect(reloadedUser.passwordHash).toBe("live-hash");

    // Live driver metadata must NOT be overwritten
    expect(reloadedDriver.experienceLevel).toBe("ELITE");

    // Missing regions from the seed should be added
    expect(reloadedDriver.regions).toContain("Zona Norte");
  });

  it("links referredByDriverId when a valid referral code is provided", async () => {
  const driverUser = await prisma.user.create({
    data: {
      name: "Driver Owner",
      email: "driver-owner@test.com",
      phone: "21999999999",
      role: "DRIVER",
      passwordHash: await bcrypt.hash("123456", 10),
    },
  });

  const driver = await prisma.driver.create({
    data: {
      userId: driverUser.id,
      isActive: true,
      experienceLevel: "PROFISSIONAL",
      regions: ["ZN"],
    },
  });

  const response = await request(app)
    .post("/auth/register")
    .send({
      name: "Alice Referral",
      email: "alice-referral@test.com",
      password: "123456",
      role: "passenger",
      phone: "21999999998",
      referralCode: driver.referralCode,
    });

  console.log("REGISTER RESPONSE:", response.status, response.body);

  expect(response.status).toBe(201);
  expect(response.body.passengerId).toBeDefined();

  const passenger = await prisma.passenger.findUnique({
    where: {
      id: response.body.passengerId,
    },
  });

  expect(passenger).not.toBeNull();
  expect(passenger?.referredByDriverId).toBe(driver.id);
});
});