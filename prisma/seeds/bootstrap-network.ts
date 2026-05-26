import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import { PrismaClient, ExperienceLevel, VehicleCategory } from "@prisma/client";
import { createDriverReferralChain } from "../../src/domain/services/DriverReferralService";

type SeedDriver = {
  name: string;
  email: string;
  phone?: string;
  referralCode: string;
  publicSlug: string;
  parentReferralCode?: string;
  experienceLevel?: ExperienceLevel;
  region?: string;
  regions?: string[];
  vehicle?: {
    model: string;
    brand: string;
    plate: string;
    category: VehicleCategory;
  };
};

const REGION_CODE_MAP: Record<string, string> = {
  ZN: "Zona Norte",
  ZS: "Zona Sul",
  ZL: "Zona Leste",
  ZO: "Zona Oeste",
  CN: "Centro",
  BC: "Barra da Tijuca",
  NI: "Niterói",
  SG: "São Gonçalo",
};

function resolveRegions(seed: SeedDriver): string[] {
  if (seed.regions && seed.regions.length > 0) return seed.regions;
  if (seed.region) return [REGION_CODE_MAP[seed.region] ?? seed.region];
  return [];
}

function loadDriverNetwork(): SeedDriver[] {
  const content = fs.readFileSync(
    path.join(process.cwd(), "prisma", "drivers-seed.json"),
    "utf8"
  );
  return JSON.parse(content) as SeedDriver[];
}

export async function runBootstrapNetwork(
  prisma: PrismaClient,
  options: { dryRun?: boolean } = {}
): Promise<{ createdDrivers: number; updatedDrivers: number; createdEdges: number; createdVehicles: number }> {
  const { dryRun = false } = options;
  const passwordHash = await bcrypt.hash("123456", 10);
  const driversByReferralCode = new Map<string, string>();
  const driverNetwork = loadDriverNetwork();
  let createdDrivers = 0;
  let updatedDrivers = 0;
  let createdEdges = 0;
  let createdVehicles = 0;

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

    let user = existingUser;
    if (!user) {
      if (dryRun) {
        console.log(`[DRY-RUN CREATE USER] ${seedDriver.email}`);
        createdDrivers++;
        // Use a sentinel so edge counting still works in the second pass
        driversByReferralCode.set(seedDriver.referralCode, `dry-run-${seedDriver.referralCode}`);
        continue;
      }
      user = await prisma.user.create({
        data: {
          name: seedDriver.name,
          email: seedDriver.email,
          phone: seedDriver.phone ?? "00000000000",
          role: "DRIVER",
          passwordHash,
        },
      });
    }

    const networkLevel = referrerDriverId ? (referrer?.networkLevel ?? 0) + 1 : 0;

    const driver = existingDriverByReferralCode
      ? await (async () => {
          // Preserve live fields — only fill null/missing values
          const existing = existingDriverByReferralCode;
          const existingRegions = new Set(existing.regions);
          const missingRegions = resolveRegions(seedDriver).filter((r) => !existingRegions.has(r));
          const mergedRegions =
            missingRegions.length > 0
              ? [...existing.regions, ...missingRegions]
              : undefined;

          console.log(`[UPDATE DRIVER] ${seedDriver.name} (referralCode: ${seedDriver.referralCode})`);
          if (dryRun) {
            updatedDrivers++;
            return existing;
          }
          updatedDrivers++;
          const updated = await prisma.driver.update({
            where: { id: existing.id },
            data: {
              isActive: true,
              // Never overwrite experienceLevel or publicSlug — they are live data
              ...(existing.publicSlug == null ? { publicSlug: seedDriver.publicSlug } : {}),
              // Only add missing regions, never replace
              ...(mergedRegions ? { regions: mergedRegions } : {}),
              // Only fill null referral chain fields
              ...(existing.referredByDriverId == null && referrerDriverId ? { referredByDriverId: referrerDriverId } : {}),
              ...(existing.networkLevel === 0 && referrerDriverId ? { networkLevel } : {}),
            },
          });
          if (mergedRegions) console.log(`[REGIONS ADDED] ${missingRegions.join(", ")}`);
          console.log(`[PUBLIC SLUG] ${updated.publicSlug}`);
          console.log(`[NETWORK LEVEL] ${updated.networkLevel}`);
          return updated;
        })()
      : await (async () => {
          // No driver found by referralCode — find or create by userId
          const existingByUserId = await prisma.driver.findUnique({ where: { userId: user.id } });

          if (existingByUserId) {
            // Driver exists with a different referralCode — preserve live fields
            const existingRegions = new Set(existingByUserId.regions);
            const missingRegions = resolveRegions(seedDriver).filter((r) => !existingRegions.has(r));
            const mergedRegions =
              missingRegions.length > 0
                ? [...existingByUserId.regions, ...missingRegions]
                : undefined;

            console.log(`[UPDATE DRIVER by userId] ${seedDriver.name} (referralCode preserved)`);
            updatedDrivers++;
            return await prisma.driver.update({
              where: { id: existingByUserId.id },
              data: {
                isActive: true,
                ...(existingByUserId.publicSlug == null ? { publicSlug: seedDriver.publicSlug } : {}),
                ...(mergedRegions ? { regions: mergedRegions } : {}),
                ...(existingByUserId.referredByDriverId == null && referrerDriverId ? { referredByDriverId: referrerDriverId } : {}),
                ...(existingByUserId.networkLevel === 0 && referrerDriverId ? { networkLevel } : {}),
              },
            });
          }

          console.log(`[CREATE DRIVER] ${seedDriver.name} (referralCode: ${seedDriver.referralCode})`);
          if (dryRun) {
            createdDrivers++;
            return existingByUserId ?? { id: `dry-run-${seedDriver.referralCode}`, regions: [], referralCode: seedDriver.referralCode } as any;
          }
          createdDrivers++;
          return await prisma.driver.create({
            data: {
              userId: user.id,
              isActive: true,
              experienceLevel: seedDriver.experienceLevel ?? "PROFISSIONAL",
              referredByDriverId: referrerDriverId,
              networkLevel,
              publicSlug: seedDriver.publicSlug,
              referralCode: seedDriver.referralCode,
              regions: resolveRegions(seedDriver),
            },
          });
        })();

    driversByReferralCode.set(seedDriver.referralCode, driver.id);

    if (!dryRun && seedDriver.vehicle) {
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
      createdVehicles++;
    }
  }

  // Pass 2: materialize the full multi-level referral chain.
  // `getDriverNetworkSnapshot()` expects `driverReferral` edges already stored with correct `level` values
  // relative to each upstream referrer.
  for (const seedDriver of driverNetwork) {
    if (!seedDriver.parentReferralCode) continue;

    const referrerDriverId = driversByReferralCode.get(seedDriver.parentReferralCode);
    const referredDriverId = driversByReferralCode.get(seedDriver.referralCode);

    if (!referrerDriverId || !referredDriverId) continue;

    if (dryRun) continue;

    await createDriverReferralChain(referredDriverId, referrerDriverId, prisma);
  }


  console.log("\n✅ Bootstrap complete.");
  console.log(`✅ ${driversByReferralCode.size} drivers upserted.`);
  return { createdDrivers, updatedDrivers, createdEdges, createdVehicles };
}
