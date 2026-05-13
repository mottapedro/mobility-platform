import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import { PrismaClient, ExperienceLevel, VehicleCategory } from "@prisma/client";
import { createDriverReferralChain } from "../../src/domain/services/DriverReferralService";

type SeedDriver = {
  name: string;
  email: string;
  phone: string;
  referralCode: string;
  publicSlug: string;
  parentReferralCode?: string;
  experienceLevel: ExperienceLevel;
  regions: string[];
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

    const networkLevel = referrerDriverId ? (referrer?.networkLevel ?? 0) + 1 : 0;

    const driver = existingDriverByReferralCode
      ? await (async () => {
          console.log(`[UPDATE DRIVER] ${seedDriver.name} (referralCode: ${seedDriver.referralCode})`);
          const updated = await prisma.driver.update({
            where: { id: existingDriverByReferralCode.id },
            data: {
              isActive: true,
              experienceLevel: seedDriver.experienceLevel,
              regions: seedDriver.regions,
              ...(existingDriverByReferralCode.publicSlug == null ? { publicSlug: seedDriver.publicSlug } : {}),
              ...(existingDriverByReferralCode.referredByDriverId == null && referrerDriverId ? { referredByDriverId: referrerDriverId } : {}),
              ...(existingDriverByReferralCode.networkLevel === 0 && referrerDriverId ? { networkLevel } : {}),
            },
          });
          console.log(`[REGIONS UPDATED] ${seedDriver.regions.join(", ")}`);
          console.log(`[PUBLIC SLUG] ${updated.publicSlug}`);
          console.log(`[NETWORK LEVEL] ${updated.networkLevel}`);
          return updated;
        })()
      : await (async () => {
          console.log(`[UPSERT DRIVER] ${seedDriver.name} (referralCode: ${seedDriver.referralCode})`);
          const created = await prisma.driver.upsert({
            where: { userId: user.id },
            update: {
              isActive: true,
              experienceLevel: seedDriver.experienceLevel,
              regions: seedDriver.regions,
              publicSlug: seedDriver.publicSlug,
              ...(referrerDriverId ? { referredByDriverId: referrerDriverId, networkLevel } : {}),
            },
            create: {
              userId: user.id,
              isActive: true,
              experienceLevel: seedDriver.experienceLevel,
              referredByDriverId: referrerDriverId,
              networkLevel,
              publicSlug: seedDriver.publicSlug,
              referralCode: seedDriver.referralCode,
              regions: seedDriver.regions,
            },
          });
          console.log(`[REGIONS UPDATED] ${seedDriver.regions.join(", ")}`);
          console.log(`[PUBLIC SLUG] ${created.publicSlug}`);
          console.log(`[NETWORK LEVEL] ${created.networkLevel}`);
          return created;
        })();

    driversByReferralCode.set(seedDriver.referralCode, driver.id);

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
      console.log(`[CREATE REFERRAL EDGE] ${seedDriver.parentReferralCode} -> ${seedDriver.referralCode}`);
      await createDriverReferralChain(referredDriverId, referrerDriverId, prisma as unknown as typeof import("../../src/infra/prisma/client").prisma);
    }
  }

  console.log("\n✅ Bootstrap complete.");
  console.log(`✅ ${driversByReferralCode.size} drivers upserted.`);
}
