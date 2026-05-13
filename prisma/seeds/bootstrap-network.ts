import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import { PrismaClient, ExperienceLevel, VehicleCategory, Region } from "@prisma/client";
import { buildDriverPublicSlug } from "../../src/domain/services/DriverIdentityService";
import { createDriverReferralChain } from "../../src/domain/services/DriverReferralService";

type SeedDriver = {
  name: string;
  email: string;
  phone: string;
  referralCode: string;
  parentReferralCode?: string;
  experienceLevel: ExperienceLevel;
  region: Region;
  vehicle: {
    model: string;
    brand: string;
    plate: string;
    category: VehicleCategory;
  };
};

function loadDriverNetwork(): SeedDriver[] {
  const content = fs.readFileSync(
    path.join(process.cwd(), "prisma", "drivers-seed.json"),
    "utf8"
  );
  return JSON.parse(content) as SeedDriver[];
}

export async function runBootstrapNetwork(prisma: PrismaClient) {
  const passwordHash = await bcrypt.hash("123456", 10);
  const driversByReferralCode = new Map<string, string>();
  const driverNetwork = loadDriverNetwork();

  for (const seedDriver of driverNetwork) {
    const publicSlug = buildDriverPublicSlug(seedDriver.name);
    const referrerDriverId = seedDriver.parentReferralCode
      ? driversByReferralCode.get(seedDriver.parentReferralCode) ?? null
      : null;
    const referrer = referrerDriverId
      ? await prisma.driver.findUnique({ where: { id: referrerDriverId }, select: { networkLevel: true } })
      : null;

    const existingDriverByReferralCode = await prisma.driver.findUnique({
      where: { referralCode: seedDriver.referralCode },
    });
    const existingUser = existingDriverByReferralCode
      ? await prisma.user.findUnique({ where: { id: existingDriverByReferralCode.userId } })
      : await prisma.user.findUnique({ where: { email: seedDriver.email } });

    const user = existingUser ?? await prisma.user.create({
      data: {
        name: seedDriver.name,
        email: seedDriver.email,
        phone: seedDriver.phone,
        role: "DRIVER",
        passwordHash,
      },
    });

    const driver = existingDriverByReferralCode
      ? await prisma.driver.update({
          where: { id: existingDriverByReferralCode.id },
          data: {
            isActive: true,
            experienceLevel: seedDriver.experienceLevel,
            ...(existingDriverByReferralCode.publicSlug == null ? { publicSlug } : {}),
            ...(existingDriverByReferralCode.referredByDriverId == null && referrerDriverId ? { referredByDriverId: referrerDriverId } : {}),
            ...(existingDriverByReferralCode.networkLevel === 0 && referrerDriverId ? { networkLevel: (referrer?.networkLevel ?? 0) + 1 } : {}),
          },
        })
      : await prisma.driver.upsert({
          where: { userId: user.id },
          update: {
            isActive: true,
            experienceLevel: seedDriver.experienceLevel,
            ...(referrerDriverId ? { referredByDriverId: referrerDriverId, networkLevel: (referrer?.networkLevel ?? 0) + 1 } : {}),
            ...(publicSlug ? { publicSlug } : {}),
          },
          create: {
            userId: user.id,
            isActive: true,
            experienceLevel: seedDriver.experienceLevel,
            referredByDriverId: referrerDriverId,
            networkLevel: referrerDriverId ? (referrer?.networkLevel ?? 0) + 1 : 0,
            publicSlug,
            referralCode: seedDriver.referralCode,
          },
        });

    driversByReferralCode.set(seedDriver.referralCode, driver.id);

    await prisma.driverRegion.upsert({
      where: {
        driverId_region: {
          driverId: driver.id,
          region: seedDriver.region,
        },
      },
      update: {},
      create: {
        driverId: driver.id,
        region: seedDriver.region,
      },
    });

    await prisma.vehicle.upsert({
      where: { plate: seedDriver.vehicle.plate },
      update: {
        driverId: driver.id,
        model: seedDriver.vehicle.model,
        brand: seedDriver.vehicle.brand,
        category: seedDriver.vehicle.category,
      },
      create: {
        driverId: driver.id,
        model: seedDriver.vehicle.model,
        brand: seedDriver.vehicle.brand,
        plate: seedDriver.vehicle.plate,
        category: seedDriver.vehicle.category,
      },
    });
  }

  for (const seedDriver of driverNetwork) {
    if (!seedDriver.parentReferralCode) {
      continue;
    }

    const referrerDriverId = driversByReferralCode.get(seedDriver.parentReferralCode);
    const referredDriverId = driversByReferralCode.get(seedDriver.referralCode);

    if (referrerDriverId && referredDriverId) {
      await createDriverReferralChain(referredDriverId, referrerDriverId, prisma as unknown as typeof import("../../src/infra/prisma/client").prisma);
    }
  }
}
