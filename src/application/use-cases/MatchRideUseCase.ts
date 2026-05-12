import { prisma } from "../../infra/prisma/client";
import { RideContext } from "../../presentation/controllers/ride.controller";
import { DriverRegionMatcher } from "../../domain/services/DriverRegionMatcher";
import { getDriverNetwork } from "../../domain/services/DriverReferralService";
import { RegionResolver } from "../../domain/services/RegionResolver";

export type MatchLevel = "REFERRED" | "NETWORK_L1" | "NETWORK_L2" | "NETWORK_L3" | "GENERAL";

// Tempo de exclusividade do motorista indicado antes do fallback para MATCHING geral
const REFERRAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos

export interface MatchInput {
  rideId: string;
  level?: MatchLevel;
  excludedDriverIds?: string[];
}

// ─── Lógica de prioridade por contexto ─────────────────────────────────────
type PriorityLevel = "HIGH" | "MEDIUM" | "LOW";

function calculatePriority(context: RideContext | null): PriorityLevel {
  if (!context) return "LOW";
  const score =
    (context.isVip     ? 4 : 0) +
    (context.isAirport ? 2 : 0) +
    (context.isPet     ? 1 : 0) +
    (context.isLuggage ? 1 : 0);
  if (score >= 4) return "HIGH";
  if (score >= 2) return "MEDIUM";
  return "LOW";
}

// Filtra e ordena drivers baseado no contexto da corrida
function applyContextFilters(
  drivers: { id: string; experienceLevel: string; vehicles: { category: string }[] }[],
  context: RideContext | null
): { id: string; experienceLevel: string; vehicles: { category: string }[] }[] {
  if (!context) return drivers;

  let filtered = [...drivers];

  // vip → priorizar ELITE primeiro
  if (context.isVip) {
    const elite = filtered.filter(d => d.experienceLevel === "ELITE");
    const others = filtered.filter(d => d.experienceLevel !== "ELITE");
    filtered = [...elite, ...others];
    console.log(`⭐ VIP: ${elite.length} drivers ELITE priorizados`);
  }

  // airport → priorizar categoria EXECUTIVO
  if (context.isAirport) {
    const exec = filtered.filter(d => d.vehicles.some(v => v.category === "EXECUTIVO"));
    const others = filtered.filter(d => !d.vehicles.some(v => v.category === "EXECUTIVO"));
    filtered = [...exec, ...others];
    console.log(`✈️ Aeroporto: ${exec.length} drivers EXECUTIVO priorizados`);
  }

  // luggage → priorizar EXECUTIVO (veículo maior)
  if (context.isLuggage && !context.isAirport) {
    const exec = filtered.filter(d => d.vehicles.some(v => v.category === "EXECUTIVO"));
    const others = filtered.filter(d => !d.vehicles.some(v => v.category === "EXECUTIVO"));
    filtered = [...exec, ...others];
    console.log(`💼 Bagagem: ${exec.length} drivers EXECUTIVO priorizados`);
  }

  // pet → por ora não filtra (simulação), apenas loga
  if (context.isPet) {
    console.log(`🐶 Pet: todos os drivers disponíveis (filtro futuro)`);
  }

  return filtered;
}

export class MatchRideUseCase {
  constructor(
    private readonly regionResolver = new RegionResolver(),
    private readonly driverRegionMatcher = new DriverRegionMatcher()
  ) {}

  private async getGeneralCandidateDrivers(
    origin: string,
    alreadyOfferedIds: Set<string>,
    rideContext: RideContext | null
  ): Promise<{ id: string; experienceLevel: string; vehicles: { category: string }[] }[]> {
    const resolvedRegion = this.regionResolver.resolve(origin);
    const regionalMatches = await this.driverRegionMatcher.execute({ region: resolvedRegion });
    const regionalDriverIds = regionalMatches
      .map((match) => match.driverId)
      .filter((driverId) => !alreadyOfferedIds.has(driverId));

    if (regionalDriverIds.length > 0) {
      const regionalDriversRaw = await prisma.driver.findMany({
        where: {
          id: { in: regionalDriverIds },
          isActive: true,
        },
        select: { id: true, experienceLevel: true, vehicles: { select: { category: true } } },
      });

      const ordering = new Map(regionalDriverIds.map((driverId, index) => [driverId, index]));
      regionalDriversRaw.sort((left, right) => {
        return (ordering.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (ordering.get(right.id) ?? Number.MAX_SAFE_INTEGER);
      });

      return applyContextFilters(regionalDriversRaw, rideContext);
    }

    const generalDriversRaw = await prisma.driver.findMany({
      where: {
        isActive: true,
        id: { notIn: [...alreadyOfferedIds] },
      },
      select: { id: true, experienceLevel: true, vehicles: { select: { category: true } } },
    });

    return applyContextFilters(generalDriversRaw, rideContext);
  }

  // ─── Derivar próximo nível com base no estado atual das offers ──────────────
  private async deriveLevel(
    rideId: string,
    referredDriverId: string | null
  ): Promise<MatchLevel> {
    if (!referredDriverId) return "GENERAL";

    const referredOffer = await prisma.rideOffer.findFirst({
      where: { rideRequestId: rideId, driverId: referredDriverId },
    });

    if (!referredOffer) return "REFERRED";

    // Referred driver already tried — check network levels
    const network = await getDriverNetwork(referredDriverId);

    const triedOffers = await prisma.rideOffer.findMany({
      where: { rideRequestId: rideId },
      select: { driverId: true },
    });
    const triedSet = new Set(triedOffers.map((o) => o.driverId));

    if (network.level1.some((id) => !triedSet.has(id))) return "NETWORK_L1";
    if (network.level2.some((id) => !triedSet.has(id))) return "NETWORK_L2";
    if (network.level3.some((id) => !triedSet.has(id))) return "NETWORK_L3";

    return "GENERAL";
  }

  // ─── Criar offer com tolerância a duplicidade ───────────────────────────────
  private async createOffer(rideId: string, driverId: string, expiresAt: Date) {
    try {
      await prisma.rideOffer.create({
        data: { rideRequestId: rideId, driverId, expiresAt },
      });
      console.log(`📨 Offer enviada para driver ${driverId}`);
    } catch {
      // Ignora violação de @@unique (offer duplicada)
    }
  }

  // ─── Execução principal ─────────────────────────────────────────────────────
  async execute(
    input: MatchInput
  ): Promise<{ matched: boolean; level: MatchLevel }> {
    const { rideId, excludedDriverIds = [] } = input;

    // 1. Buscar corrida com passenger
    const ride = await prisma.rideRequest.findUnique({
      where: { id: rideId },
      include: { passenger: true },
    });

    if (!ride) throw new Error("Ride not found");

    // Guard: só faz matching em corridas que ainda podem ser matchadas
    if (!["PENDING", "MATCHING", "WAITING_REFERRAL"].includes(ride.status)) {
      console.log(`⚠️ Corrida ${rideId} ignorada — status: ${ride.status}`);
      return { matched: false, level: "GENERAL" };
    }

    const referredDriverId = ride.passenger.referredByDriverId ?? null;
    const rideContext = (ride.context ?? null) as RideContext | null;
    const priority = calculatePriority(rideContext);

    // 2. Derivar nível se não fornecido
    const level = input.level ?? (await this.deriveLevel(rideId, referredDriverId));

    console.log(`🚀 Matching iniciado (${level} | prioridade: ${priority}) para corrida ${rideId}`);
    if (rideContext) console.log(`🎯 Contexto:`, rideContext);

    // 3. IDs já com offer nessa corrida (evita duplicidade e respeita re-match)
    const existingOffers = await prisma.rideOffer.findMany({
      where: { rideRequestId: rideId },
      select: { driverId: true },
    });
    const alreadyOfferedIds = new Set([
      ...existingOffers.map((o) => o.driverId),
      ...excludedDriverIds,
    ]);

    const expiresAt = new Date(Date.now() + 2 * 60 * 1000);

    // ── Tier 1: REFERRED ─────────────────────────────────────────────────────
    if (level === "REFERRED") {
      if (!referredDriverId) {
        return this.execute({ rideId, level: "GENERAL", excludedDriverIds });
      }

      if (alreadyOfferedIds.has(referredDriverId)) {
        return this.execute({ rideId, level: "NETWORK_L1", excludedDriverIds });
      }

      const referredDriver = await prisma.driver.findFirst({
        where: { id: referredDriverId, isActive: true },
      });

      if (!referredDriver) {
        console.log(`⚠️ Driver indicado ${referredDriverId} inativo — escalando para NETWORK_L1`);
        return this.execute({ rideId, level: "NETWORK_L1", excludedDriverIds });
      }

      // ✅ Modo referral: aguarda 60s antes de abrir para outros
      await prisma.rideRequest.update({
        where: { id: rideId },
        data: { status: "WAITING_REFERRAL" },
      });

      await this.createOffer(rideId, referredDriverId, expiresAt);
        console.log(`⏳ Corrida ${rideId} em WAITING_REFERRAL — fallback em ${REFERRAL_TIMEOUT_MS / 1000}s`);
      console.log("Referral timeout iniciado:", rideId);

      // Timeout: se ainda WAITING_REFERRAL após REFERRAL_TIMEOUT_MS → escalar para rede antes do pool geral
      setTimeout(async () => {
        try {
          // Atomic check-and-update: only proceeds if status is still WAITING_REFERRAL
          const updated = await prisma.rideRequest.updateMany({
            where: { id: rideId, status: "WAITING_REFERRAL" },
            data: { status: "MATCHING" },
          });

          if (updated.count === 0) return; // Already handled by accept/reject/manual-fallback

          console.log("Referral expirado → fallback NETWORK_L1:", rideId);

          // Expirar offer ainda pendente do driver indicado (evita aceitação tardia)
          await prisma.rideOffer.updateMany({
            where: { rideRequestId: rideId, driverId: referredDriverId, status: "PENDING" },
            data: { status: "EXPIRED" },
          });

          await this.execute({
            rideId,
            level: "NETWORK_L1",
            excludedDriverIds: [...excludedDriverIds, referredDriverId],
          });
        } catch (err) {
          console.error(`🔥 Erro no timeout referral para corrida ${rideId}:`, err);
        }
      }, REFERRAL_TIMEOUT_MS);

      return { matched: true, level };
    }

    // ── Tier 2-4: NETWORK LEVELS ─────────────────────────────────────────────
    if (level === "NETWORK_L1" || level === "NETWORK_L2" || level === "NETWORK_L3") {
      if (!referredDriverId) {
        return this.execute({ rideId, level: "GENERAL", excludedDriverIds });
      }

      await prisma.rideRequest.update({
        where: { id: rideId },
        data: { status: "MATCHING" },
      });

      const network = await getDriverNetwork(referredDriverId);
      const networkMap: Record<string, string[]> = {
        NETWORK_L1: network.level1,
        NETWORK_L2: network.level2,
        NETWORK_L3: network.level3,
      };
      const candidates = networkMap[level].filter((id) => !alreadyOfferedIds.has(id));

      const candidateDrivers = await prisma.driver.findMany({
        where: { id: { in: candidates }, isActive: true },
        select: { id: true, experienceLevel: true, vehicles: { select: { category: true } } },
      });

      const filtered = applyContextFilters(candidateDrivers, rideContext);

      console.log(`🌐 Network ${level}: ${filtered.length} drivers disponíveis`);

      if (filtered.length === 0) {
        const nextLevel: Record<string, MatchLevel> = {
          NETWORK_L1: "NETWORK_L2",
          NETWORK_L2: "NETWORK_L3",
          NETWORK_L3: "GENERAL",
        };
        const next = nextLevel[level] ?? "GENERAL";
        return this.execute({ rideId, level: next, excludedDriverIds });
      }

      for (const driver of filtered) {
        await this.createOffer(rideId, driver.id, expiresAt);
      }
      return { matched: true, level };
    }

    // ── Tier 3: GENERAL ───────────────────────────────────────────────────────
    await prisma.rideRequest.update({
      where: { id: rideId },
      data: { status: "MATCHING" },
    });

    const generalDrivers = await this.getGeneralCandidateDrivers(
      ride.origin,
      alreadyOfferedIds,
      rideContext
    );

    if (generalDrivers.length === 0) {
      console.log(`⚠️ Nenhum driver disponível para corrida ${rideId}`);
      return { matched: false, level };
    }

    for (const driver of generalDrivers) {
      await this.createOffer(rideId, driver.id, expiresAt);
    }
    return { matched: true, level };
  }
}
