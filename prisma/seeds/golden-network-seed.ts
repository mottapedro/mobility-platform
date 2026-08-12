import bcrypt from "bcryptjs";
import { ExperienceLevel, VehicleCategory, Region, RideStatus, RideOfferStatus, DriverSkillCode } from "@prisma/client";
import { createDriverReferralChain } from "../../src/domain/services/DriverReferralService";
import { assignSkill } from "../../src/domain/skills/DriverSkillService";
import { prisma as sharedPrisma } from "../../src/infra/prisma/client";
import { ActorType } from "../../src/shared/enums";
import { recordRelationship } from "../../src/domain/referral-network/ReferralRelationshipService";
import { RootOwnershipProjectionService } from "../../src/domain/ownership/RootOwnershipProjectionService";
import { resolveDriverRoot } from "../../src/domain/referral-network/DriverRootResolverService";
import { seedRevenuePolicies } from "./revenue-policy.seed";
import { seedOwnershipPolicies } from "./ownership-policy.seed";


// ─────────────────────────────────────────────────────────────────────────────
// GOLDEN NETWORK OFICIAL — Pedro Paulo Motta como raiz
// Real credentials provided by the operator.
// ─────────────────────────────────────────────────────────────────────────────
const REAL_NETWORK = {
  PEDRO:   { email: "mottapedro01@gmail.com",         phone: "21981722517" },
  JOAO:    { email: "jln@gmail.com",                   phone: "21994693673" },
  // Level-1 via Pedro (sem dados reais — placeholder)
  ANSELMO: { email: "anselmo.valle@aliado.mobility",   phone: "21900001001" },
  FERNANDO:{ email: "fernando.barreira@aliado.mobility",phone: "21900001002" },
  CARLOS:  { email: "carlos.henrique@aliado.mobility", phone: "21900001003" },
  // Level-1 via João (level-2 via Pedro)
  CARLINHOS:{ email: "carlinhos.city@aliado.mobility", phone: "21900001004" },
  JENNER:  { email: "jenner.spin@aliado.mobility",     phone: "21900001005" },
  BIRA:    { email: "bira.onix@aliado.mobility",       phone: "21900001006" },
  GISELE:  { email: "gisele.colecionador@aliado.mobility", phone: "21900001007" },
  FABIO:   { email: "fabio.tcross@aliado.mobility",    phone: "21900001008" },
  ANDRE:   { email: "andre.cabral@aliado.mobility",    phone: "21900001009" },
};

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY DRIVER EMAILS — kept for backward compatibility with existing tests.
// Pedro and João are canonical identities (REAL_NETWORK: mottapedro01@gmail.com,
// jln@gmail.com) created by the official seed only. The legacy seed resolves
// them instead of creating duplicate Users/Drivers.
// ─────────────────────────────────────────────────────────────────────────────
const DRIVER_EMAIL = {
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

// ─────────────────────────────────────────────────────────────────────────────
// Skill catalogue — the baseline does not carry the migration-seeded Skill rows
// (they live in 20260526000000_aliado_v2_referral_skills). The golden seed must
// be self-contained on a baseline-only DB, so upsert the catalogue idempotently.
// ─────────────────────────────────────────────────────────────────────────────
const SKILL_CATALOG: Array<{ code: DriverSkillCode; displayName: string; description: string }> = [
  { code: DriverSkillCode.COLECIONADOR, displayName: "Colecionador", description: "Motorista com perfil de recorrência e fidelização." },
  { code: DriverSkillCode.EXECUTIVO, displayName: "Executivo", description: "Atende corridas executivas." },
  { code: DriverSkillCode.TRANSPORTE_ASSISTIDO, displayName: "Transporte Assistido", description: "Habilitado para passageiros que necessitam de apoio." },
  { code: DriverSkillCode.AEROPORTO, displayName: "Aeroporto", description: "Especialista em corridas para/de aeroporto." },
  { code: DriverSkillCode.LONG_DISTANCE, displayName: "Longa Distância", description: "Corridas intermunicipais." },
  { code: DriverSkillCode.PREMIUM, displayName: "Premium", description: "Veículo e atendimento premium." },
  { code: DriverSkillCode.VIP, displayName: "VIP", description: "Atendimento VIP." },
];

async function seedSkillCatalog(prisma: any) {
  for (const skill of SKILL_CATALOG) {
    await prisma.skill.upsert({
      where: { code: skill.code },
      update: { displayName: skill.displayName, description: skill.description },
      create: { code: skill.code, displayName: skill.displayName, description: skill.description },
    });
  }
  console.log(`  ✅ Skill catalogue (${SKILL_CATALOG.length} entries) upserted`);
}

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
  prisma: any,
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
  prisma: any,
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
    metadata?: Record<string, unknown>;
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
      ...(params.metadata !== undefined ? { metadata: params.metadata as any } : {}),
          // keep existing regions, add missing
          regions: Array.from(
            new Set([
              ...(await prisma.driver.findUnique({ where: { userId: user.id } })
                ?.then((d: { regions: Region[] }) => d?.regions)
                .then((r: Region[]) => r ?? []) ?? []),
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
      ...(params.metadata !== undefined ? { metadata: params.metadata as any } : {}),
    },
    select: { id: true, userId: true, regions: true, referralCode: true, publicSlug: true, isActive: true, experienceLevel: true, networkLevel: true, referredByDriverId: true, metadata: true },
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

  // Idempotent availability — no unique compound key in schema, so skipDuplicates
  // would silently no-op and duplicate rows on a second run. Use a deterministic
  // (driverId, dayOfWeek) lookup with update-or-create instead.
  const existingAvailability = await prisma.driverAvailability.findFirst({
    where: { driverId: driver.id, dayOfWeek: 1 },
  });
  if (existingAvailability) {
    await prisma.driverAvailability.update({
      where: { id: existingAvailability.id },
      data: { startTime: "08:00", endTime: "20:00" },
    });
  } else {
    await prisma.driverAvailability.create({
      data: { driverId: driver.id, dayOfWeek: 1, startTime: "08:00", endTime: "20:00" },
    });
  }

  return driver;
}

// Resolve a driver by its canonical identity email. Used by the legacy seed to
// re-attach its hierarchy edges to the official Pedro/João records instead of
// creating duplicate Users/Drivers.
async function findDriverByEmail(prisma: any, email: string) {
  return prisma.user
    .findUnique({
      where: { email },
      select: { id: true, driver: { select: { id: true } } },
    })
    .then((u: { id: string; driver: { id: string } | null } | null) => {
      if (!u?.driver) {
        throw new Error(`[GoldenSeed] canonical driver not found for ${email} — official seed must run first`);
      }
      return { id: u.driver.id, userId: u.id };
    });
}

async function upsertPassenger(
  prisma: any,
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
  prisma: any,
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
  // No stable unique key in schema; match by the stable identity
  // (passengerId, origin, destination). scheduledAt is deliberately excluded —
  // it's derived from runtime `now`, so a second run would produce a different
  // timestamp and never match the first run's row.
  const existing = await prisma.rideRequest.findFirst({
    where: {
      passengerId: params.passengerId,
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

// ─────────────────────────────────────────────────────────────────────────────
// GOLDEN NETWORK OFICIAL — uses real operational data
// Structure:
//   Pedro Paulo Motta (root)
//     ├─ João Luiz Correa de Brito  [level-1]
//     │   ├─ Carlinhos (Honda City)     [level-1 João / level-2 Pedro]
//     │   ├─ Jenner (Spin)              [level-1 João / level-2 Pedro]
//     │   ├─ Bira (Onix LTZ)           [level-1 João / level-2 Pedro]
//     │   ├─ Gisele (Peugeot 208)      [level-1 João / level-2 Pedro] — skill: Colecionador
//     │   ├─ Fábio (T-Cross)           [level-1 João / level-2 Pedro]
//     │   └─ André Cabral (Etios)      [level-1 João / level-2 Pedro]
//     ├─ Anselmo Valle                  [level-1]
//     ├─ Fernando Barreira              [level-1]
//     └─ Carlos Henrique               [level-1]
// ─────────────────────────────────────────────────────────────────────────────
export async function runOfficialGoldenNetworkSeed(prisma: any) {
  console.log("🌟 Seeding Golden Network Oficial — Pedro Paulo Motta como raiz...");

  // ── Root: Pedro Paulo Motta ──────────────────────────────────────────────
  const pedro = await upsertDriverWithVehicleAndRegions(prisma, {
    email: REAL_NETWORK.PEDRO.email,
    name: "Pedro Paulo Motta",
    phone: REAL_NETWORK.PEDRO.phone,
    experienceLevel: ExperienceLevel.ELITE,
    isActive: true,
    referralCode: "pedro-motta-zn-elite",
    publicSlug: "pedro-motta",
    regions: [Region.ZN],
    vehicle: { plate: "PPM-0001", model: "Accord", brand: "Honda", category: VehicleCategory.EXECUTIVO },
  });
  console.log(`  ✅ Pedro Paulo Motta — driver.id=${pedro.id}`);

  // ── Level-1: João Luiz Correa de Brito ──────────────────────────────────
  const joao = await upsertDriverWithVehicleAndRegions(prisma, {
    email: REAL_NETWORK.JOAO.email,
    name: "João Luiz Correa de Brito",
    phone: REAL_NETWORK.JOAO.phone,
    experienceLevel: ExperienceLevel.PROFISSIONAL,
    isActive: true,
    referralCode: "joao-luiz-correa-brito-zn",
    publicSlug: "joao-luiz-correa-brito",
    regions: [Region.ZN],
    vehicle: { plate: "JLB-0002", model: "Corolla", brand: "Toyota", category: VehicleCategory.EXECUTIVO },
  });

  // ── Level-1: Anselmo Valle ───────────────────────────────────────────────
  const anselmo = await upsertDriverWithVehicleAndRegions(prisma, {
    email: REAL_NETWORK.ANSELMO.email,
    name: "Anselmo Valle",
    phone: REAL_NETWORK.ANSELMO.phone,
    experienceLevel: ExperienceLevel.INTERMEDIARIO,
    isActive: true,
    referralCode: "anselmo-valle-zn",
    publicSlug: "anselmo-valle",
    regions: [Region.ZN],
    vehicle: { plate: "ANS-0003", model: "Onix", brand: "Chevrolet", category: VehicleCategory.CONFORTO },
  });

  // ── Level-1: Fernando Barreira ───────────────────────────────────────────
  const fernando = await upsertDriverWithVehicleAndRegions(prisma, {
    email: REAL_NETWORK.FERNANDO.email,
    name: "Fernando Barreira",
    phone: REAL_NETWORK.FERNANDO.phone,
    experienceLevel: ExperienceLevel.INTERMEDIARIO,
    isActive: true,
    referralCode: "fernando-barreira-zn",
    publicSlug: "fernando-barreira",
    regions: [Region.ZN],
    vehicle: { plate: "FEB-0004", model: "HB20", brand: "Hyundai", category: VehicleCategory.CONFORTO },
  });

  // ── Level-1: Carlos Henrique ─────────────────────────────────────────────
  const carlosH = await upsertDriverWithVehicleAndRegions(prisma, {
    email: REAL_NETWORK.CARLOS.email,
    name: "Carlos Henrique",
    phone: REAL_NETWORK.CARLOS.phone,
    experienceLevel: ExperienceLevel.INICIANTE,
    isActive: true,
    referralCode: "carlos-henrique-zn",
    publicSlug: "carlos-henrique",
    regions: [Region.ZN],
    vehicle: { plate: "CAH-0005", model: "Gol", brand: "Volkswagen", category: VehicleCategory.CONFORTO },
  });

  // ── Level-1 via João (level-2 via Pedro): Carlinhos ─────────────────────
  const carlinhos = await upsertDriverWithVehicleAndRegions(prisma, {
    email: REAL_NETWORK.CARLINHOS.email,
    name: "Carlinhos",
    phone: REAL_NETWORK.CARLINHOS.phone,
    experienceLevel: ExperienceLevel.INTERMEDIARIO,
    isActive: true,
    referralCode: "carlinhos-city-zn",
    publicSlug: "carlinhos-city",
    regions: [Region.ZN],
    vehicle: { plate: "CAR-0006", model: "City", brand: "Honda", category: VehicleCategory.CONFORTO },
  });

  // ── Level-1 via João (level-2 via Pedro): Jenner ─────────────────────────
  const jenner = await upsertDriverWithVehicleAndRegions(prisma, {
    email: REAL_NETWORK.JENNER.email,
    name: "Jenner",
    phone: REAL_NETWORK.JENNER.phone,
    experienceLevel: ExperienceLevel.INTERMEDIARIO,
    isActive: true,
    referralCode: "jenner-spin-zn",
    publicSlug: "jenner-spin",
    regions: [Region.ZN],
    vehicle: { plate: "JEN-0007", model: "Spin", brand: "Chevrolet", category: VehicleCategory.CONFORTO },
  });

  // ── Level-1 via João (level-2 via Pedro): Bira ───────────────────────────
  const bira = await upsertDriverWithVehicleAndRegions(prisma, {
    email: REAL_NETWORK.BIRA.email,
    name: "Bira",
    phone: REAL_NETWORK.BIRA.phone,
    experienceLevel: ExperienceLevel.INTERMEDIARIO,
    isActive: true,
    referralCode: "bira-onix-ltz-zn",
    publicSlug: "bira-onix",
    regions: [Region.ZN],
    vehicle: { plate: "BIR-0008", model: "Onix LTZ", brand: "Chevrolet", category: VehicleCategory.CONFORTO },
  });

  // ── Level-1 via João (level-2 via Pedro): Gisele — skill: Colecionador ──
  // metadata.skills: ["Colecionador"] — estrutura extensível, sem tabela própria por enquanto
  const gisele = await upsertDriverWithVehicleAndRegions(prisma, {
    email: REAL_NETWORK.GISELE.email,
    name: "Gisele",
    phone: REAL_NETWORK.GISELE.phone,
    experienceLevel: ExperienceLevel.PROFISSIONAL,
    isActive: true,
    referralCode: "gisele-colecionador-zn",
    publicSlug: "gisele-colecionador",
    regions: [Region.ZN],
    vehicle: { plate: "GIS-0009", model: "208", brand: "Peugeot", category: VehicleCategory.CONFORTO },
    metadata: { skills: ["Colecionador"], badges: [], tier: null },
  });

  // ── Level-1 via João (level-2 via Pedro): Fábio ──────────────────────────
  const fabio = await upsertDriverWithVehicleAndRegions(prisma, {
    email: REAL_NETWORK.FABIO.email,
    name: "Fábio",
    phone: REAL_NETWORK.FABIO.phone,
    experienceLevel: ExperienceLevel.INTERMEDIARIO,
    isActive: true,
    referralCode: "fabio-tcross-zn",
    publicSlug: "fabio-tcross",
    regions: [Region.ZN],
    vehicle: { plate: "FAB-0010", model: "T-Cross", brand: "Volkswagen", category: VehicleCategory.CONFORTO },
  });

  // ── Level-1 via João (level-2 via Pedro): André Cabral ───────────────────
  const andre = await upsertDriverWithVehicleAndRegions(prisma, {
    email: REAL_NETWORK.ANDRE.email,
    name: "André Cabral",
    phone: REAL_NETWORK.ANDRE.phone,
    experienceLevel: ExperienceLevel.INICIANTE,
    isActive: true,
    referralCode: "andre-cabral-etios-zn",
    publicSlug: "andre-cabral",
    regions: [Region.ZN],
    vehicle: { plate: "AND-0011", model: "Etios", brand: "Toyota", category: VehicleCategory.CONFORTO },
  });

  console.log("  ✅ 10 drivers criados/atualizados (Pedro + 9 aliados)");

  // ── Referral chains ─────────────────────────────────────────────────────
  // Pedro → João (direct, level 1)
  await createDriverReferralChain(joao.id, pedro.id, prisma);
  // Pedro → Anselmo (direct, level 1)
  await createDriverReferralChain(anselmo.id, pedro.id, prisma);
  // Pedro → Fernando (direct, level 1)
  await createDriverReferralChain(fernando.id, pedro.id, prisma);
  // Pedro → Carlos Henrique (direct, level 1)
  await createDriverReferralChain(carlosH.id, pedro.id, prisma);
  console.log("  ✅ Pedro: 4 indicações diretas criadas (level 1)");

  // João → Carlinhos (direct, level 1 João / level 2 Pedro inherited)
  await createDriverReferralChain(carlinhos.id, joao.id, prisma);
  // João → Jenner
  await createDriverReferralChain(jenner.id, joao.id, prisma);
  // João → Bira
  await createDriverReferralChain(bira.id, joao.id, prisma);
  // João → Gisele
  await createDriverReferralChain(gisele.id, joao.id, prisma);
  // João → Fábio
  await createDriverReferralChain(fabio.id, joao.id, prisma);
  // João → André Cabral
  await createDriverReferralChain(andre.id, joao.id, prisma);
  console.log("  ✅ João: 6 indicações diretas criadas (level 1 João / level 2 Pedro herdado)");

  // ── V2 relational projection ────────────────────────────────────────────
  // Ensure every direct D2D edge is also recorded in ReferralRelationship so
  // the V2 network read model matches the legacy closure table on fresh seeds.
  const v2DirectEdges = [
    { inviterId: pedro.id, invitedId: joao.id },
    { inviterId: pedro.id, invitedId: anselmo.id },
    { inviterId: pedro.id, invitedId: fernando.id },
    { inviterId: pedro.id, invitedId: carlosH.id },
    { inviterId: joao.id, invitedId: carlinhos.id },
    { inviterId: joao.id, invitedId: jenner.id },
    { inviterId: joao.id, invitedId: bira.id },
    { inviterId: joao.id, invitedId: gisele.id },
    { inviterId: joao.id, invitedId: fabio.id },
    { inviterId: joao.id, invitedId: andre.id },
  ];
  for (const edge of v2DirectEdges) {
    await recordRelationship(
      {
        inviterActorType: ActorType.DRIVER,
        inviterId: edge.inviterId,
        invitedActorType: ActorType.DRIVER,
        invitedId: edge.invitedId,
      },
      prisma
    ).catch((err) => {
      console.warn(
        `[GoldenSeed] V2 relationship record failed for ${edge.invitedId}:`,
        err?.message
      );
    });
  }
  console.log("  ✅ V2: 10 relational referral edges recorded");

  // ── V2 relational passengers for the official network ─────────────────────
  // The frontend "Clientes / Rede" tab shows passengers from the genealogy,
  // which reads ReferralRelationship. Without D2P edges the official root
  // driver appears with 0 passengers.
  const officialPassenger1 = await upsertPassenger(prisma, {
    email: "passageiro.oficial.1@aliado.mobility",
    name: "Passageiro Oficial 1",
    phone: "21990001001",
    referralCode: "passageiro-oficial-1",
    publicSlug: "passageiro-oficial-1",
    referredByDriverId: pedro.id,
    rootPassengerId: null,
    networkLevel: 0,
    lineagePath: [],
  });
  const officialPassenger2 = await upsertPassenger(prisma, {
    email: "passageiro.oficial.2@aliado.mobility",
    name: "Passageiro Oficial 2",
    phone: "21990001002",
    referralCode: "passageiro-oficial-2",
    publicSlug: "passageiro-oficial-2",
    referredByDriverId: joao.id,
    rootPassengerId: null,
    networkLevel: 0,
    lineagePath: [],
  });

  // Project ownership so Passenger.rootDriverId is set correctly.
  await prisma.passenger.updateMany({
    where: { id: { in: [officialPassenger1.id, officialPassenger2.id] } },
    data: { rootDriverId: pedro.id },
  });
  await RootOwnershipProjectionService.projectPassengerOwnership(officialPassenger1.id, prisma).catch(() => null);
  await RootOwnershipProjectionService.projectPassengerOwnership(officialPassenger2.id, prisma).catch(() => null);

  // Record D2P edges so the genealogy tree includes these passengers.
  const officialPassengerEdges = [
    { inviterActorType: ActorType.DRIVER, inviterId: pedro.id, invitedActorType: ActorType.PASSENGER, invitedId: officialPassenger1.id },
    { inviterActorType: ActorType.DRIVER, inviterId: joao.id, invitedActorType: ActorType.PASSENGER, invitedId: officialPassenger2.id },
  ];
  for (const edge of officialPassengerEdges) {
    await recordRelationship(edge, prisma).catch((err) => {
      console.warn(`[GoldenSeed] official passenger relationship failed:`, err?.message);
    });
  }
  console.log("  ✅ V2: 2 official network passengers registered");

  // V2 — assign relational skill catalogue entry to Gisele
  await assignSkill(
    { driverId: gisele.id, code: DriverSkillCode.COLECIONADOR },
    prisma as any
  );
  console.log("  ✅ Gisele: skill COLECIONADOR registrada (DriverSkill V2)");

  console.log("🌟 Golden Network Oficial concluída!");
  console.log("   Pedro nível 1: João, Anselmo, Fernando, Carlos Henrique (4)");
  console.log("   Pedro nível 2 (herdado): Carlinhos, Jenner, Bira, Gisele, Fábio, André (6)");
  console.log("   João nível 1: Carlinhos, Jenner, Bira, Gisele, Fábio, André (6)");
  console.log("   Gisele metadata.skills: ['Colecionador']");

  return { pedro, joao, anselmo, fernando, carlosH, carlinhos, jenner, bira, gisele, fabio, andre };
}

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY SEED — kept for backward compatibility with existing tests/fixtures
// ─────────────────────────────────────────────────────────────────────────────
export async function runGoldenNetworkSeed(prisma: any) {
  // Ensure base tables exist via upsert.

  // 1) Drivers (golden set)
  // Pedro and João are canonical identities created by the official seed
  // (REAL_NETWORK.PEDRO = mottapedro01@gmail.com, REAL_NETWORK.JOAO = jln@gmail.com).
  // Resolve them here so the legacy hierarchy reuses the canonical records —
  // never recreate duplicate Users/Drivers with legacy emails.
  const pedro = await findDriverByEmail(prisma, REAL_NETWORK.PEDRO.email);
  const joao = await findDriverByEmail(prisma, REAL_NETWORK.JOAO.email);

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

  // Mirror the three legacy-only direct D2D edges into the V2 read model.
  const legacyV2DirectEdges = [
    { inviterId: pedro.id, invitedId: peter.id },
    { inviterId: peter.id, invitedId: ana.id },
    { inviterId: pedro.id, invitedId: roberto.id },
  ];
  for (const edge of legacyV2DirectEdges) {
    await recordRelationship(
      {
        inviterActorType: ActorType.DRIVER,
        inviterId: edge.inviterId,
        invitedActorType: ActorType.DRIVER,
        invitedId: edge.invitedId,
      },
      prisma
    );
  }
  console.log("  ✅ V2: 3 legacy D2D referral edges recorded");

  // 3) Passengers (hierarchy)
  // Helper: project rootDriverId from the referring driver/passenger so the
  // V2 ownership model matches the legacy hierarchy. Without this the
  // frontend "Clientes" tab (which filters by Passenger.rootDriverId) stays empty.
  async function upsertPassengerWithOwnership(
    prisma: any,
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
    const passenger = await upsertPassenger(prisma, params);

    let rootDriverId: string | null = null;
    if (params.referredByDriverId) {
      rootDriverId = await resolveDriverRoot(ActorType.DRIVER, params.referredByDriverId, prisma).catch(() => null);
    } else if (params.rootPassengerId) {
      rootDriverId = await prisma.passenger
        .findUnique({ where: { id: params.rootPassengerId }, select: { rootDriverId: true } })
        .then((p: { rootDriverId: string | null } | null) => p?.rootDriverId ?? null)
        .catch(() => null);
    }

    if (rootDriverId) {
      await prisma.passenger.update({
        where: { id: passenger.id },
        data: { rootDriverId },
      });
      await RootOwnershipProjectionService.projectPassengerOwnership(passenger.id, prisma).catch(() => null);
    }

    return passenger;
  }

  const passengerPeterRoot = await upsertPassengerWithOwnership(prisma, {
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

  const passengerMaria = await upsertPassengerWithOwnership(prisma, {
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

  const passengerAna = await upsertPassengerWithOwnership(prisma, {
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

  const passengerNoDriver = await upsertPassengerWithOwnership(prisma, {
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

  // V2 relational projection for passenger hierarchy (D2P + P2P edges)
  // The frontend genealogy tree reads ReferralRelationship, so these edges are required
  // for passengers to appear under the root driver's network view.
  const v2PassengerEdges = [
    { inviterActorType: ActorType.DRIVER, inviterId: pedro.id, invitedActorType: ActorType.PASSENGER, invitedId: passengerPeterRoot.id },
    { inviterActorType: ActorType.DRIVER, inviterId: pedro.id, invitedActorType: ActorType.PASSENGER, invitedId: passengerMaria.id },
    { inviterActorType: ActorType.DRIVER, inviterId: ana.id, invitedActorType: ActorType.PASSENGER, invitedId: passengerAna.id },
    { inviterActorType: ActorType.PASSENGER, inviterId: passengerPeterRoot.id, invitedActorType: ActorType.PASSENGER, invitedId: passengerMaria.id },
    { inviterActorType: ActorType.PASSENGER, inviterId: passengerMaria.id, invitedActorType: ActorType.PASSENGER, invitedId: passengerAna.id },
  ];
  for (const edge of v2PassengerEdges) {
    await recordRelationship(edge, prisma).catch((err) => {
      console.warn(`[GoldenSeed] V2 passenger relationship failed:`, err?.message);
    });
  }
  console.log("  ✅ V2: passenger hierarchy edges recorded");

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
  const prisma = sharedPrisma;
  try {
    // Structural domain configuration first (single source of truth lives in
    // the policy seed routines — never duplicated here).
    await seedRevenuePolicies(prisma);
    await seedOwnershipPolicies(prisma);
    await seedSkillCatalog(prisma);
    // Official network first: creates the canonical identities (mottapedro01@gmail.com,
    // jln@gmail.com). The legacy seed resolves those same identities to attach its
    // hierarchy edges — never duplicate records.
    await runOfficialGoldenNetworkSeed(prisma);
    await runGoldenNetworkSeed(prisma);
    console.log("✅ Golden network seed (structural policies + oficial + legacy) complete");
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
