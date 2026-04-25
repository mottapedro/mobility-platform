import "dotenv/config";
import fs from "fs";
import { PrismaClient, ExperienceLevel, VehicleCategory, Region } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("🌱 Iniciando seed de drivers...");

  const driversData = [
    {
      name: "Carlos Silva",
      email: "carlos@driver.com",
      phone: "11999990001",
      experienceLevel: ExperienceLevel.PROFISSIONAL,
      vehicle: {
        model: "Corolla",
        brand: "Toyota",
        plate: "ABC-1234",
        category: VehicleCategory.EXECUTIVO,
      },
      region: Region.ZN,
    },
    {
      name: "Marcos Lima",
      email: "marcos@driver.com",
      phone: "11999990002",
      experienceLevel: ExperienceLevel.INTERMEDIARIO,
      vehicle: {
        model: "HB20",
        brand: "Hyundai",
        plate: "DEF-5678",
        category: VehicleCategory.CONFORTO,
      },
      region: Region.ZS,
    },
    {
      name: "Roberto Souza",
      email: "roberto@driver.com",
      phone: "11999990003",
      experienceLevel: ExperienceLevel.ELITE,
      vehicle: {
        model: "Civic",
        brand: "Honda",
        plate: "GHI-9012",
        category: VehicleCategory.EXECUTIVO,
      },
      region: Region.ZO,
    },
  ];

  const createdDrivers: { name: string; driverId: string | undefined; email: string; region: Region }[] = [];
  const createdDriversMap = new Map<string, string>(); // name → driverId

  for (const data of driversData) {
    const existing = await prisma.user.findUnique({ where: { email: data.email } });

    if (existing) {
      console.log(`⚠️  Driver ${data.name} já existe, pulando...`);

      const existingDriver = await prisma.driver.findUnique({
        where: { userId: existing.id },
      });
      createdDrivers.push({
        name: existing.name,
        driverId: existingDriver?.id,
        email: existing.email,
        region: data.region,
      });
      if (existingDriver?.id) createdDriversMap.set(data.name, existingDriver.id);
      continue;
    }

    const user = await prisma.user.create({
      data: {
        name: data.name,
        email: data.email,
        phone: data.phone,
        role: "DRIVER",
        driver: {
          create: {
            experienceLevel: data.experienceLevel,
            isActive: true,
            vehicles: {
              create: [data.vehicle],
            },
            regions: {
              create: [{ region: data.region }],
            },
          },
        },
      },
      include: { driver: true },
    });

    const driverInfo = {
      name: user.name,
      driverId: user.driver?.id,
      email: user.email,
      region: data.region,
    };

    createdDrivers.push(driverInfo);
    if (user.driver?.id) createdDriversMap.set(data.name, user.driver.id);

    console.log(`✅ Driver criado:`);
    console.log(driverInfo);
  }

  // 🔗 Criar rede de indicação: Carlos indica Marcos e Roberto
  const carlosId = createdDriversMap.get("Carlos Silva");
  const marcosId = createdDriversMap.get("Marcos Lima");
  const robertoId = createdDriversMap.get("Roberto Souza");

  if (carlosId && marcosId) {
    const marcos = await prisma.driver.findUnique({
      where: { id: marcosId },
      select: { id: true, referredByDriverId: true },
    });
    if (!marcos?.referredByDriverId) {
      await prisma.driver.update({
        where: { id: marcosId },
        data: { referredByDriverId: carlosId },
      });
      console.log(`🔗 Rede: Carlos Silva → Marcos Lima`);
    } else {
      console.log(`⚠️  Marcos Lima já tem referência, pulando...`);
    }
  }

  if (carlosId && robertoId) {
    const roberto = await prisma.driver.findUnique({
      where: { id: robertoId },
      select: { id: true, referredByDriverId: true },
    });
    if (!roberto?.referredByDriverId) {
      await prisma.driver.update({
        where: { id: robertoId },
        data: { referredByDriverId: carlosId },
      });
      console.log(`🔗 Rede: Carlos Silva → Roberto Souza`);
    } else {
      console.log(`⚠️  Roberto Souza já tem referência, pulando...`);
    }
  }

  console.log("\n📦 DRIVERS DISPONÍVEIS PARA TESTE:\n");
  createdDrivers.forEach((driver) => {
    console.log(`👤 ${driver.name}`);
    console.log(`   driverId: ${driver.driverId}`);
    console.log(`   region:   ${driver.region}`);
    console.log("------");
  });

  if (createdDrivers.length > 0) {
    fs.writeFileSync(
      "./prisma/drivers-seed.json",
      JSON.stringify(createdDrivers, null, 2)
    );
    console.log("\n📁 prisma/drivers-seed.json gerado com sucesso!");
  }

  console.log("🌱 Seed concluído!");
}

main()
  .catch((e) => {
    console.error("🔥 Erro no seed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
