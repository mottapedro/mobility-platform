import bcrypt from "bcryptjs";
import { PrismaClient, ExperienceLevel, VehicleCategory, Region, RideStatus, RideOfferStatus } from "@prisma/client";
import { createDriverReferralChain } from "../../src/domain/services/DriverReferralService";

const DRIVER_EMAIL = {
  PEDRO: "pedro.paulo.motta@mobility.com",
  JOAO: "joao.luiz.brito@mobility.com",
  ANA_RECURRENCE: "ana.claudia.silva@mobility.com",
  ROBERTO: "roberto.souza@mobility.com",
  EXECUTIVE_2: "peter.jackson@mobility.com",
};

const PASSENGER_EMAIL = {
  ROOT_PETER: "peter.jackson.passenger@mobility.com",
  MARIA_FERNANDA: "maria.fernanda.passenger@mobility.com",
  ANA_CLAUDIA: "ana.claudia.passenger@mobility.com",
  NO_DRIVER: "sem.motorista.passenger@mobility.com",
  MARIA_WITHOUT: "maria.fernanda.no.driver@mobility.com",
};

function asRegion(v: string): Region {
  return (Object.values(Region) as string[]).includes(v) ? (v as Region) : Region.ZN;
}

function asExperienceLevel(v: string): ExperienceLevel {
  return (Object.values(ExperienceLevel) as string[]).includes(v) ? (v as ExperienceLevel) : ExperienceLevel.INICIANTE;
}

function asVehicleCategory(v: string): VehicleCategory {
  return (Object.values(VehicleCategory) as string[]).includes(v) ? (v as VehicleCategory) : VehicleCategory.CONFORTO;
}

async function upsertUser(
  prisma: PrismaClient,
  params: { email: string; name: string; phone: string; role: "DRIVER" | "PASSENGER"; password?: string }
) {
  const { email, name, phone, role } = params;
  const passwordHash = await bcrypt.hash(params.password ?? "123456", 10);

  return prisma.user.upsert({
    where: { email },
    update: {
      name,
      phone,
      role,
      // keep passwordHash stable if already exists
      ...(await prisma.user.findUnique({ where: { email } })?.then(() => ({})) ?? {}),
    },
    create: {
      name,
      email,
      phone,
      role,
      passwordHash,
    },
  });
}

async function upsertDriverWithVehicleAndRegions(
  prisma: PrismaClient,
  params: {
    email: string;
    name: string;
    phone: string;
    experienceLevel: ExperienceLevel;
    isActive: boolean;
    referralCode: string;
    publicSlug: string;
    regions: Region[];
    vehicle: { plate: string; model: string; brand: string; category: VehicleCategory };
  }
) {
  const user = await upsertUser(prisma, { email: params.email, name: params.name, phone: params.phone, role: "DRIVER" });

  const driver = await prisma.driver.upsert({
    where: { userId: user.id },
    update: {
      isActive: params.isActive,
      experienceLevel: params.experienceLevel,
      referralCode: params.referralCode,
      publicSlug: params.publicSlug,
      // keep existing regions, add missing
      regions: Array.from(
        new Set([
          ...(await prisma.driver.findUnique({ where: { userId: user.id } })
            ?.then((d) => d?.regions)
            .then((r) => r ?? []) ?? []),
          ...params.regions,
        ])
      ),
    },
    create: {
      userId: user.id,
      isActive: params.isActive,
      experienceLevel: params.experienceLevel,
      referralCode: params.referralCode,
      publicSlug: params.publicSlug,
      regions: params.regions,
    },
    select: { id: true, userId: true, regions: true, referralCode: true, publicSlug: true, isActive: true, experienceLevel: true, networkLevel: true, referredByDriverId: true },
  });

  await prisma.vehicle.upsert({
    where: { plate: params.vehicle.plate },
    update: {
      driverId: driver.id,
      model: params.vehicle.model,
      brand: params.vehicle.brand,
      category: params.vehicle.category,
    },
    create: {
      plate: params.vehicle.plate,
      driverId: driver.id,
      model: params.vehicle.model,
      brand: params.vehicle.brand,
      category: params.vehicle.category,
    },
  });

  // idempotent availability (no unique compound key in schema)
  await prisma.driverAvailability.createMany({
    data: [{ driverId: driver.id, dayOfWeek: 1, startTime: "08:00", endTime: "20:00" }],
    skipDuplicates: true,
  }).catch(() => Promise.resolve());

  return driver;
}

async function upsertPassenger(
  prisma: PrismaClient,
  params: {
    email: string;
    name: string;
    phone: string;
    referralCode: string;
    publicSlug: string | null;
    referredByDriverId: string | null;
    rootPassengerId: string | null;
    networkLevel: number;
    lineagePath: string[];
  }
) {
  const user = await upsertUser(prisma, { email: params.email, name: params.name, phone: params.phone, role: "PASSENGER" });

  const passenger = await prisma.passenger.upsert({
    where: { userId: user.id },
    update: {
      referralCode: params.referralCode,
      publicSlug: params.publicSlug,
      referredByDriverId: params.referredByDriverId,
      rootPassengerId: params.rootPassengerId,
      networkLevel: params.networkLevel,
      lineagePath: params.lineagePath,
    },
    create: {
      userId: user.id,
      referralCode: params.referralCode,
      publicSlug: params.publicSlug,
      referredByDriverId: params.referredByDriverId,
      rootPassengerId: params.rootPassengerId,
      networkLevel: params.networkLevel,
      lineagePath: params.lineagePath,
    },
  });

  return passenger;
}

async function upsertRide(
  prisma: PrismaClient,
  params: {
    passengerId: string;
    status: RideStatus;
    scheduledAt: Date;
    origin: string;
    destination: string;
    selectedDriverId?: string | null;
    context?: unknown;
  }
) {
  // No stable unique key in schema; upsert by (passengerId, scheduledAt, origin, destination)
  const existing = await prisma.rideRequest.findFirst({
    where: {
      passengerId: params.passengerId,
      scheduledAt: params.scheduledAt,
      origin: params.origin,
      destination: params.destination,
    },
  });

  if (existing) {
    return prisma.rideRequest.update({
      where: { id: existing.id },
      data: {
        status: params.status,
        scheduledAt: params.scheduledAt,
        selectedDriverId: params.selectedDriverId ?? null,
        ...(params.context ? { context: params.context as any } : {}),
      },
    });
  }

  return prisma.rideRequest.create({
    data: {
      passengerId: params.passengerId,
      origin: params.origin,
      destination: params.destination,
      scheduledAt: params.scheduledAt,
      status: params.status,
      selectedDriverId: params.selectedDriverId ?? null,
      context: params.context ? (params.context as any) : null,
      offers: params.selectedDriverId
        ? {
            create: [
              {
                driverId: params.selectedDriverId,
                status: (RideOfferStatus.ACCEPTED as any),
                expiresAt: new Date(Date.now() + 1000 * 60 * 30),
                respondedAt: params.status === RideStatus.COMPLETED ? new Date() : null,
              },
            ],
          }
        : undefined,
    },
    include: { offers: true },
  });
}

export async function runGoldenNetworkSeed(prisma: PrismaClient) {
  // Ensure base tables exist via upsert.

  // 1) Drivers (golden set)
  const pedro = await upsertDriverWithVehicleAndRegions(prisma, {
    email: DRIVER_EMAIL.PEDRO,
    name: "Pedro Paulo Motta",
    phone: "21981722517",
    experienceLevel: ExperienceLevel.PROFISSIONAL,
    isActive: true,
    referralCode: "pedro-paulo-motta-zn-premium",
    publicSlug: "pedro-paulo-motta",
    regions: [Region.ZN],
    vehicle: { plate: "PEDRO-1111", model: "Accord", brand: "Honda", category: VehicleCategory.EXECUTIVO },
  });

  const joao = await upsertDriverWithVehicleAndRegions(prisma, {
    email: DRIVER_EMAIL.JOAO,
    name: "João Luiz Correa de Brito",
    phone: "21994693673",
    experienceLevel: ExperienceLevel.INTERMEDIARIO,
    isActive: true,
    referralCode: "joao-luiz-transporte-assistido",
    publicSlug: "joao-luiz-brito",
    regions: [Region.ZS],
    vehicle: { plate: "JOAO-2222", model: "Logan", brand: "Renault", category: VehicleCategory.CONFORTO },
  });

  const ana = await upsertDriverWithVehicleAndRegions(prisma, {
    email: DRIVER_EMAIL.ANA_RECURRENCE,
    name: "Ana Claudia Elias da Silva",
    phone: "21974771788",
    experienceLevel: ExperienceLevel.ELITE,
    isActive: true,
    referralCode: "ana-claudia-recorrencia",
    publicSlug: "ana-claudia-elias",
    regions: [Region.ZO],
    vehicle: { plate: "ANA-3333", model: "Civic", brand: "Honda", category: VehicleCategory.EXECUTIVO },
  });

  const roberto = await upsertDriverWithVehicleAndRegions(prisma, {
    email: DRIVER_EMAIL.ROBERTO,
    name: "Roberto Souza",
    phone: "11999990003",
    experienceLevel: ExperienceLevel.ELITE,
    isActive: true,
    referralCode: "roberto-executivo-elite",
    publicSlug: "roberto-souza",
    regions: [Region.ZN],
    vehicle: { plate: "ROB-4444", model: "Corolla", brand: "Toyota", category: VehicleCategory.EXECUTIVO },
  });

  const peter = await upsertDriverWithVehicleAndRegions(prisma, {
    email: DRIVER_EMAIL.EXECUTIVE_2,
    name: "Peter Jackson",
    phone: "11999990004",
    experienceLevel: ExperienceLevel.INTERMEDIARIO,
    isActive: true,
    referralCode: "peter-jackson-network",
    publicSlug: "peter-jackson",
    regions: [Region.ZS],
    vehicle: { plate: "PETER-5555", model: "HB20", brand: "Hyundai", category: VehicleCategory.CONFORTO },
  });

  // 2) Driver referral network edges (multi-level)
  // Pedro -> Peter (level1)
  await createDriverReferralChain(peter.id, pedro.id, prisma);
  // Pedro -> João (level1)
  await createDriverReferralChain(joao.id, pedro.id, prisma);
  // Peter -> Ana (level2)
  await createDriverReferralChain(ana.id, peter.id, prisma);
  // Pedro -> Roberto (level1)
  await createDriverReferralChain(roberto.id, pedro.id, prisma);

  // 3) Passengers (hierarchy)
  const passengerPeterRoot = await upsertPassenger(prisma, {
    email: PASSENGER_EMAIL.ROOT_PETER,
    name: "Peter Jackson (Passenger)",
    phone: "21999990001",
    referralCode: "passenger-peter-root-zn",
    publicSlug: "peter-jackson-passenger",
    referredByDriverId: pedro.id,
    rootPassengerId: null,
    networkLevel: 0,
    lineagePath: [],
  });

  const passengerMaria = await upsertPassenger(prisma, {
    email: PASSENGER_EMAIL.MARIA_FERNANDA,
    name: "Maria Fernanda",
    phone: "21999990002",
    referralCode: "passenger-maria-fernanda",
    publicSlug: "maria-fernanda",
    referredByDriverId: pedro.id,
    rootPassengerId: passengerPeterRoot.id,
    networkLevel: 1,
    lineagePath: [passengerPeterRoot.id],
  });

  const passengerAna = await upsertPassenger(prisma, {
    email: PASSENGER_EMAIL.ANA_CLAUDIA,
    name: "Ana Claudia (Passenger)",
    phone: "21999990003",
    referralCode: "passenger-ana-claudia-l2",
    publicSlug: "ana-claudia-passenger",
    referredByDriverId: ana.id,
    rootPassengerId: passengerPeterRoot.id,
    networkLevel: 2,
    lineagePath: [passengerPeterRoot.id, passengerMaria.id],
  });

  const passengerNoDriver = await upsertPassenger(prisma, {
    email: PASSENGER_EMAIL.NO_DRIVER,
    name: "Passageiro sem motorista aliado",
    phone: "21999990004",
    referralCode: "passenger-no-driver",
    publicSlug: "sem-motorista",
    referredByDriverId: null,
    rootPassengerId: null,
    networkLevel: 0,
    lineagePath: [],
  });

  // 4) Ride requests with multiple states
  const now = new Date();

  await upsertRide(prisma, {
    passengerId: passengerPeterRoot.id,
    status: RideStatus.ACCEPTED,
    scheduledAt: new Date(now.getTime() - 1000 * 60 * 60 * 24),
    origin: "Rua A",
    destination: "Rua B",
    selectedDriverId: pedro.id,
    context: { pix: { key: "pix-golden-pending", status: "PENDING" } },
  });

  await upsertRide(prisma, {
    passengerId: passengerPeterRoot.id,
    status: RideStatus.COMPLETED,
    scheduledAt: new Date(now.getTime() - 1000 * 60 * 60 * 48),
    origin: "Rua C",
    destination: "Rua D",
    selectedDriverId: roberto.id,
    context: { pix: { key: "pix-golden-paid", status: "PAID" } },
  });

  await upsertRide(prisma, {
    passengerId: passengerMaria.id,
    status: RideStatus.IN_PROGRESS,
    scheduledAt: new Date(now.getTime() - 1000 * 60 * 30),
    origin: "Praça 1",
    destination: "Praça 2",
    selectedDriverId: peter.id,
    context: { pix: { key: "pix-golden-inprogress", status: "PENDING" } },
  });

  await upsertRide(prisma, {
    passengerId: passengerAna.id,
    status: RideStatus.WAITING_DRIVER,
    scheduledAt: new Date(now.getTime() + 1000 * 60 * 60 * 3),
    origin: "Av 9",
    destination: "Av 10",
    selectedDriverId: joao.id,
    context: { pix: { key: "pix-golden-scheduled", status: "PENDING" } },
  });

  await upsertRide(prisma, {
    passengerId: passengerNoDriver.id,
    status: RideStatus.PENDING,
    scheduledAt: new Date(now.getTime() + 1000 * 60 * 60 * 5),
    origin: "Origem X",
    destination: "Destino Y",
    selectedDriverId: null,
    context: { pix: { key: "pix-golden-nodriver", status: "PENDING" } },
  });
}

export async function main() {
  const prisma = new PrismaClient();
  try {
    await runGoldenNetworkSeed(prisma);
    console.log("✅ Golden network seed complete");
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error("Golden seed failed", e);
    process.exit(1);
  });
}

