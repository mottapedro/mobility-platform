import { PrismaClient, ExperienceLevel, VehicleCategory, Region } from "@prisma/client";

const DRIVER_PROFILES: Record<string, {
  experienceLevel: ExperienceLevel;
  vehicle: { model: string; brand: string; plate: string; category: VehicleCategory };
  region: Region;
}> = {
  "mottapedro01@gmail.com": {
    experienceLevel: ExperienceLevel.PROFISSIONAL,
    vehicle: { model: "Onix Plus Turbo", brand: "Chevrolet", plate: "RJS-1234", category: VehicleCategory.EXECUTIVO },
    region: Region.ZN,
  },
  "carlos@driver.com": {
    experienceLevel: ExperienceLevel.PROFISSIONAL,
    vehicle: { model: "Corolla", brand: "Toyota", plate: "ABC-1234", category: VehicleCategory.EXECUTIVO },
    region: Region.ZN,
  },
  "marcos@driver.com": {
    experienceLevel: ExperienceLevel.INTERMEDIARIO,
    vehicle: { model: "HB20", brand: "Hyundai", plate: "DEF-5678", category: VehicleCategory.CONFORTO },
    region: Region.ZS,
  },
  "roberto@driver.com": {
    experienceLevel: ExperienceLevel.ELITE,
    vehicle: { model: "Civic", brand: "Honda", plate: "GHI-9012", category: VehicleCategory.EXECUTIVO },
    region: Region.ZO,
  },
  "jlcbrito@driver.com": {
    experienceLevel: ExperienceLevel.PROFISSIONAL,
    vehicle: { model: "Logan", brand: "Renault", plate: "UAB-1234", category: VehicleCategory.CONFORTO },
    region: Region.ZN,
  },
};

export async function seedDrivers(prisma: PrismaClient) {
  const driverUsers = await prisma.user.findMany({ where: { role: "DRIVER" } });

  for (const user of driverUsers) {
    const profile = DRIVER_PROFILES[user.email];
    if (!profile) continue;

    const existing = await prisma.driver.findUnique({ where: { userId: user.id } });
    if (existing) continue;

    await prisma.driver.create({
      data: {
        userId: user.id,
        experienceLevel: profile.experienceLevel,
        isActive: true,
        vehicles: { create: [profile.vehicle] },
        regions: { create: [{ region: profile.region }] },
      },
    });
  }

  console.log(`✅ Drivers criados`);
}
