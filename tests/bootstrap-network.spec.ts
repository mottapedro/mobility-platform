import bcrypt from "bcrypt";
import { prisma } from "./setup";
import { runBootstrapNetwork } from "../prisma/seeds/bootstrap-network";

describe("runBootstrapNetwork", () => {
  it("preserves existing live driver data and only adds missing regions", async () => {
    // Clean up any real seed driver that may have persisted from a previous run
    const existing = await prisma.driver.findUnique({ where: { referralCode: "pedro-paulo-motta-zn" } });
    if (existing) {
      await prisma.driver.updateMany({ where: { referredByDriverId: existing.id }, data: { referredByDriverId: null } });
      await prisma.driverReferral.deleteMany({ where: { OR: [{ driverId: existing.id }, { referredDriverId: existing.id }] } });
      await prisma.rideOffer.deleteMany({ where: { driverId: existing.id } });
      await prisma.vehicle.deleteMany({ where: { driverId: existing.id } });
      await prisma.driver.delete({ where: { id: existing.id } });
      await prisma.user.deleteMany({ where: { id: existing.userId } });
    }

    // Pre-create a driver whose referralCode matches the first seed entry
    // Use a test-domain email so cleanTestData() will clean it up
    // Use a test-domain email so cleanTestData() will clean it up
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
        publicSlug: "pedro-real",
        regions: [],
      },
    });

    await runBootstrapNetwork(prisma);

    const reloadedUser = await prisma.user.findUniqueOrThrow({ where: { id: existingUser.id } });
    const reloadedDriver = await prisma.driver.findUniqueOrThrow({ where: { id: existingDriver.id } });

    // Live credentials must NOT be overwritten
    expect(reloadedUser.phone).toBe("21900009999");
    expect(reloadedUser.passwordHash).toBe("live-hash");

    // Live driver metadata must NOT be overwritten
    expect(reloadedDriver.experienceLevel).toBe("ELITE");
    expect(reloadedDriver.publicSlug).toBe("pedro-real");

    // Missing regions from the seed should be added
    expect(reloadedDriver.regions).toContain("Zona Oeste");
  });

  it("does not create duplicate users, drivers, regions, vehicles, or referral edges when run twice", async () => {
    // Ensure a clean slate by removing any previously seeded drivers
    const SEED_EMAILS = [
      "mottapedro01@gmail.com", "jlcbrito@driver.com", "carlinhos@driver.com",
      "jenner@driver.com", "bira@driver.com", "gisele@driver.com", "fabio@driver.com",
      "andre.cabral@driver.com", "anselmo@driver.com", "fernando.barreira@driver.com",
    ];
    const seedUsers = await prisma.user.findMany({ where: { email: { in: SEED_EMAILS } } });
    const seedUserIds = seedUsers.map((u) => u.id);
    if (seedUserIds.length > 0) {
      const seedDrivers = await prisma.driver.findMany({ where: { userId: { in: seedUserIds } }, select: { id: true } });
      const seedDriverIds = seedDrivers.map((d) => d.id);
      if (seedDriverIds.length > 0) {
        await prisma.driver.updateMany({ where: { referredByDriverId: { in: seedDriverIds } }, data: { referredByDriverId: null } });
        await prisma.driverReferral.deleteMany({ where: { OR: [{ driverId: { in: seedDriverIds } }, { referredDriverId: { in: seedDriverIds } }] } });
        await prisma.rideOffer.deleteMany({ where: { driverId: { in: seedDriverIds } } });
        await prisma.vehicle.deleteMany({ where: { driverId: { in: seedDriverIds } } });
        await prisma.driver.deleteMany({ where: { id: { in: seedDriverIds } } });
      }
      await prisma.user.deleteMany({ where: { id: { in: seedUserIds } } });
    }

    await runBootstrapNetwork(prisma);
    await runBootstrapNetwork(prisma);

    expect(await prisma.user.count({ where: { role: "DRIVER" } })).toBe(10);
    expect(await prisma.vehicle.count()).toBe(10);
    expect(await prisma.driverReferral.count()).toBe(15);

    const pedro = await prisma.driver.findFirstOrThrow({ where: { referralCode: "pedro-paulo-motta-zn" } });
    const joao = await prisma.driver.findFirstOrThrow({ where: { referralCode: "joao-luiz-correa-de-brito-zn" } });
    const anselmo = await prisma.driver.findFirstOrThrow({ where: { referralCode: "anselmo-valle-dos-santos-zn" } });
    const fernando = await prisma.driver.findFirstOrThrow({ where: { referralCode: "fernando-barreira-zn" } });
    const andre = await prisma.driver.findFirstOrThrow({ where: { referralCode: "andre-cabral-zn" } });

    expect(joao.referredByDriverId).toBe(pedro.id);
    expect(anselmo.referredByDriverId).toBe(pedro.id);
    expect(fernando.referredByDriverId).toBe(pedro.id);
    expect(andre.referredByDriverId).toBe(joao.id);
  });
});