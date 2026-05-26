import "dotenv/config";
import { closeDevFixturesResources, runDevFixtures } from "./seeds/dev-fixtures";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, ExperienceLevel, VehicleCategory, Region } from "@prisma/client";
import bcrypt from "bcrypt";
import fs from "fs";
import { createDriverReferralChain } from "../src/domain/services/DriverReferralService";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("🌱 Iniciando seed de drivers...");

  const DEFAULT_PASSWORD_HASH = await bcrypt.hash("123456", 10);

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
    {
      name: "Pedro Paulo Motta",
      email: "mottapedro01@gmail.com",
      phone: "21981722517",
      experienceLevel: ExperienceLevel.PROFISSIONAL,
      vehicle: {
        model: "Onix Plus Turbo",
        brand: "Chevrolet",
        plate: "RJS1234",
        category: VehicleCategory.EXECUTIVO,
      },
      region: Region.ZN,
    },
    {
      name: "João Luiz Correa de Brito",
      email: "jlcbrito@driver.com",
      phone: "21994693673",
      experienceLevel: ExperienceLevel.PROFISSIONAL,
      vehicle: {
        model: "Logan",
        brand: "Renault",
        plate: "UABC1234",
        category: VehicleCategory.CONFORTO,
      },
      region: Region.ZN,
    },
  ];

  const createdDrivers: {
    name: string;
    driverId: string | undefined;
    email: string;
    region: Region;
    referralCode: string | undefined;
  }[] = [];
  const createdDriversMap = new Map<string, string>(); // name → driverId

  for (const data of driversData) {
    const existing = await prisma.user.findUnique({ where: { email: data.email } });

    if (existing) {
      // Garantir que o hash sempre corresponda à senha padrão
      if (!existing.passwordHash || !existing.passwordHash.startsWith("$2")) {
        await prisma.user.update({
          where: { id: existing.id },
          data: { passwordHash: DEFAULT_PASSWORD_HASH },
        });
        console.log(`🔑 Hash atualizado para: ${existing.email}`);
      } else {
        // Forçar update para garantir que a senha 123456 sempre funcione no seed
        await prisma.user.update({
          where: { id: existing.id },
          data: { passwordHash: DEFAULT_PASSWORD_HASH },
        });
        console.log(`🔑 Hash re-sincronizado para: ${existing.email}`);
      }

      console.log(`⚠️  Driver ${data.name} já existe, pulando criação...`);

      const existingDriver = await prisma.driver.findUnique({
        where: { userId: existing.id },
      });
      createdDrivers.push({
        name: existing.name,
        driverId: existingDriver?.id,
        email: existing.email,
        region: data.region,
        referralCode: existingDriver?.referralCode,
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
        passwordHash: DEFAULT_PASSWORD_HASH,
        driver: {
          create: {
            experienceLevel: data.experienceLevel,
            isActive: true,
            vehicles: {
              create: [data.vehicle],
            },
            regions: [data.region],
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
      referralCode: user.driver?.referralCode,
    };

    createdDrivers.push(driverInfo);
    if (user.driver?.id) createdDriversMap.set(data.name, user.driver.id);

    console.log(`✅ Driver criado:`);
    console.log(driverInfo);
  }

  // � Corrigir usuários com passwordHash nulo ou plain-text (sem prefixo bcrypt $2)
  const usersWithBadHash = await prisma.user.findMany({
    where: {
      OR: [
        { passwordHash: null },
        { NOT: { passwordHash: { startsWith: "$2" } } },
      ],
    },
    select: { id: true, email: true },
  });
  if (usersWithBadHash.length > 0) {
    for (const u of usersWithBadHash) {
      await prisma.user.update({
        where: { id: u.id },
        data: { passwordHash: DEFAULT_PASSWORD_HASH },
      });
      console.log(`🔑 Hash corrigido para: ${u.email}`);
    }
  }

  // �🔗 Criar rede de indicação: Carlos indica Marcos e Roberto
  const carlosId = createdDriversMap.get("Carlos Silva");
  const marcosId = createdDriversMap.get("Marcos Lima");
  const robertoId = createdDriversMap.get("Roberto Souza");
  const pedroId = createdDriversMap.get("Pedro Paulo Motta");
  const joaoId = createdDriversMap.get("João Luiz Correa de Brito");

  if (carlosId && marcosId) {
    const existing = await prisma.driverReferral.findFirst({
      where: { referrerDriverId: carlosId, referredDriverId: marcosId },
    });
    if (!existing) {
      await createDriverReferralChain(marcosId, carlosId, prisma);
      console.log(`🔗 Rede: Carlos Silva → Marcos Lima`);
    } else {
      console.log(`⚠️  Marcos Lima já tem referência, pulando...`);
    }
  }

  if (carlosId && robertoId) {
    const existing = await prisma.driverReferral.findFirst({
      where: { referrerDriverId: carlosId, referredDriverId: robertoId },
    });
    if (!existing) {
      await createDriverReferralChain(robertoId, carlosId, prisma);
      console.log(`🔗 Rede: Carlos Silva → Roberto Souza`);
    } else {
      console.log(`⚠️  Roberto Souza já tem referência, pulando...`);
    }
  }

  if (pedroId && joaoId) {
    const existing = await prisma.driverReferral.findFirst({
      where: { referrerDriverId: pedroId, referredDriverId: joaoId },
    });
    if (!existing) {
      await createDriverReferralChain(joaoId, pedroId, prisma);
      console.log(`🔗 Rede: Pedro Paulo Motta → João Luiz Correa de Brito`);
    } else {
      console.log(`⚠️  João Luiz já tem referência, pulando...`);
    }
  }

  console.log("\n📦 DRIVERS DISPONÍVEIS PARA TESTE:\n");
  createdDrivers.forEach((driver) => {
    console.log(`👤 ${driver.name}`);
    console.log(`   driverId: ${driver.driverId}`);
    console.log(`   referralCode: ${driver.referralCode}`);
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

  console.log("\n👤 Seeding passageiro de demo...");

  // ID usado pelo frontend como FALLBACK_PASSENGER_ID
  const DEMO_PASSENGER_ID = "b3a5278a-0ebf-4d97-8699-669951c8e41c";
  const DEMO_PASSENGER_NAME = "Ana Beatriz Santos";
  const DEMO_PASSENGER_EMAIL = "ana.beatriz@mobility.com";

  const existingPassengerUser = await prisma.user.findUnique({
    where: { email: DEMO_PASSENGER_EMAIL },
  });

  // Também procura pelo email antigo (seed anterior usava outro email)
  const oldPassengerUser = await prisma.user.findUnique({
    where: { email: "passageiro.demo@mobility.com" },
  });

  if (oldPassengerUser) {
    // Atualiza nome do usuário antigo para o nome real
    await prisma.user.update({
      where: { email: "passageiro.demo@mobility.com" },
      data: { name: DEMO_PASSENGER_NAME, email: DEMO_PASSENGER_EMAIL },
    });
    // Garante que o passenger tem o referredByDriverId correto
    // referredByDriverId on Passenger is still a valid field (Passenger→Driver relation)
    if (carlosId) {
      await prisma.passenger.updateMany({
        where: { userId: oldPassengerUser.id },
        data: { referredByDriverId: carlosId },
      });
    }
    console.log(`✅ Passageiro demo atualizado: ${DEMO_PASSENGER_NAME}`);
  } else if (!existingPassengerUser) {
    const passengerUser = await prisma.user.create({
      data: {
        name: DEMO_PASSENGER_NAME,
        email: DEMO_PASSENGER_EMAIL,
        phone: "11999990099",
        role: "PASSENGER",
        passwordHash: DEFAULT_PASSWORD_HASH,
      },
    });

    await prisma.passenger.create({
      data: {
        id: DEMO_PASSENGER_ID,
        userId: passengerUser.id,
        referredByDriverId: carlosId ?? null,
      },
    });

    console.log(`✅ Passageiro demo criado: ${DEMO_PASSENGER_ID}`);
    if (carlosId) console.log(`🔗 Indicado por: Carlos Silva`);
  } else {
    console.log(`⚠️  Passageiro demo já existe, pulando...`);
  }

  // 👤 Passageira de teste: Ana Cláudia Elias (indicada por Pedro)
  const ANA_CLAUDIA_EMAIL = "ana.claudia@email.com";
  const existingAnaClaudia = await prisma.user.findUnique({ where: { email: ANA_CLAUDIA_EMAIL } });

  if (!existingAnaClaudia) {
    const anaClaudiaUser = await prisma.user.create({
      data: {
        name: "Ana Cláudia Elias",
        email: ANA_CLAUDIA_EMAIL,
        phone: "21974771788",
        role: "PASSENGER",
        passwordHash: DEFAULT_PASSWORD_HASH,
      },
    });

    await prisma.passenger.create({
      data: {
        userId: anaClaudiaUser.id,
        referredByDriverId: pedroId ?? null,
      },
    });

    console.log(`✅ Passageira criada: Ana Cláudia Elias (ana.claudia@email.com)`);
    if (pedroId) console.log(`🔗 Indicada por: Pedro Paulo Motta`);
  } else {
    console.log(`⚠️  Ana Cláudia já existe, pulando...`);
  }

    console.log("🌱 Seed concluído!");
  }

  main()
    .catch((error) => {
      console.error("🔥 Erro no seed:", error);
      process.exit(1);
    })
    .finally(async () => {
      await closeDevFixturesResources();
    });


runDevFixtures()
  .catch((error) => {
    console.error("🔥 Erro no seed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await closeDevFixturesResources();
  });

