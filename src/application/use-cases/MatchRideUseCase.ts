import { prisma } from "../../infra/prisma/client";
import { RideContext } from "../../presentation/controllers/ride.controller";

export type MatchLevel = "REFERRED" | "PARTNER" | "GENERAL";

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
    (context.vip     ? 4 : 0) +
    (context.airport ? 2 : 0) +
    (context.pet     ? 1 : 0) +
    (context.luggage ? 1 : 0);
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
  if (context.vip) {
    const elite = filtered.filter(d => d.experienceLevel === "ELITE");
    const others = filtered.filter(d => d.experienceLevel !== "ELITE");
    filtered = [...elite, ...others];
    console.log(`⭐ VIP: ${elite.length} drivers ELITE priorizados`);
  }

  // airport → priorizar categoria EXECUTIVO
  if (context.airport) {
    const exec = filtered.filter(d => d.vehicles.some(v => v.category === "EXECUTIVO"));
    const others = filtered.filter(d => !d.vehicles.some(v => v.category === "EXECUTIVO"));
    filtered = [...exec, ...others];
    console.log(`✈️ Aeroporto: ${exec.length} drivers EXECUTIVO priorizados`);
  }

  // luggage → priorizar EXECUTIVO (veículo maior)
  if (context.luggage && !context.airport) {
    const exec = filtered.filter(d => d.vehicles.some(v => v.category === "EXECUTIVO"));
    const others = filtered.filter(d => !d.vehicles.some(v => v.category === "EXECUTIVO"));
    filtered = [...exec, ...others];
    console.log(`💼 Bagagem: ${exec.length} drivers EXECUTIVO priorizados`);
  }

  // pet → por ora não filtra (simulação), apenas loga
  if (context.pet) {
    console.log(`🐶 Pet: todos os drivers disponíveis (filtro futuro)`);
  }

  return filtered;
}

export class MatchRideUseCase {

  // ─── Derivar próximo nível com base no estado atual das offers ──────────────
  private async deriveLevel(
    rideId: string,
    referredDriverId: string | null
  ): Promise<MatchLevel> {
    // Sem driver indicado → pool geral direto
    if (!referredDriverId) return "GENERAL";

    // Verificar se o driver indicado já foi tentado
    const referredOffer = await prisma.rideOffer.findFirst({
      where: { rideRequestId: rideId, driverId: referredDriverId },
    });

    if (!referredOffer) return "REFERRED";

    // Driver indicado já foi tentado → verificar se há drivers da rede não tentados
    const networkReferrals = await prisma.driverReferral.findMany({
      where: { referrerDriverId: referredDriverId },
      select: { referredDriverId: true },
    });

    if (networkReferrals.length === 0) return "GENERAL";

    // Verificar se algum driver da rede ainda não recebeu offer
    const triedOffers = await prisma.rideOffer.findMany({
      where: { rideRequestId: rideId },
      select: { driverId: true },
    });
    const triedSet = new Set(triedOffers.map((o) => o.driverId));

    const hasUntriedNetworkDriver = networkReferrals.some(
      (r) => !triedSet.has(r.referredDriverId)
    );

    return hasUntriedNetworkDriver ? "PARTNER" : "GENERAL";
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
    if (!["PENDING", "MATCHING"].includes(ride.status)) {
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

    // 3. Atualizar status da corrida
    await prisma.rideRequest.update({
      where: { id: rideId },
      data: { status: "MATCHING" },
    });

    // 4. IDs já com offer nessa corrida (evita duplicidade e respeita re-match)
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
        return this.execute({ rideId, level: "PARTNER", excludedDriverIds });
      }

      const referredDriver = await prisma.driver.findFirst({
        where: { id: referredDriverId, isActive: true },
      });

      if (!referredDriver) {
        console.log(`⚠️ Driver indicado ${referredDriverId} inativo — escalando para PARTNER`);
        return this.execute({ rideId, level: "PARTNER", excludedDriverIds });
      }

      await this.createOffer(rideId, referredDriverId, expiresAt);
      return { matched: true, level };
    }

    // ── Tier 2: PARTNER ───────────────────────────────────────────────────────
    if (level === "PARTNER") {
      if (!referredDriverId) {
        return this.execute({ rideId, level: "GENERAL", excludedDriverIds });
      }

      const partnerExcluded = [...alreadyOfferedIds, referredDriverId];

      // Retrieve all drivers in the referral network (levels 1, 2, 3), ordered by level
      const networkReferrals = await prisma.driverReferral.findMany({
        where: {
          referrerDriverId: referredDriverId,
          referredDriverId: { notIn: [...partnerExcluded] },
        },
        orderBy: { level: "asc" },
        select: { referredDriverId: true },
      });

      const networkDriverIds = networkReferrals.map((r) => r.referredDriverId);

      const partnerDriversMap = networkDriverIds.length > 0
        ? await prisma.driver.findMany({
            where: {
              isActive: true,
              id: { in: networkDriverIds },
            },
            select: { id: true, experienceLevel: true, vehicles: { select: { category: true } } },
          }).then((rows) => new Map(rows.map((d) => [d.id, d])))
        : new Map<string, { id: string; experienceLevel: string; vehicles: { category: string }[] }>();

      // Preserve level ordering from networkReferrals
      const partnerDriversOrdered = networkDriverIds
        .map((id) => partnerDriversMap.get(id))
        .filter((d): d is { id: string; experienceLevel: string; vehicles: { category: string }[] } => d !== undefined);

      const partnerDrivers = applyContextFilters(partnerDriversOrdered, rideContext);

      console.log(`🤝 Drivers parceiros encontrados: ${partnerDrivers.length}`);

      if (partnerDrivers.length === 0) {
        console.log(`⚠️ Nenhum parceiro disponível — escalando para GENERAL`);
        return this.execute({ rideId, level: "GENERAL", excludedDriverIds });
      }

      for (const driver of partnerDrivers) {
        await this.createOffer(rideId, driver.id, expiresAt);
      }
      return { matched: true, level };
    }

    // ── Tier 3: GENERAL ───────────────────────────────────────────────────────
    const generalDriversRaw = await prisma.driver.findMany({
      where: {
        isActive: true,
        id: { notIn: [...alreadyOfferedIds] },
      },
      select: { id: true, experienceLevel: true, vehicles: { select: { category: true } } },
    });

    const generalDrivers = applyContextFilters(generalDriversRaw, rideContext);

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
