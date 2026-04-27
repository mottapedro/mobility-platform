import { prisma } from "../../infra/prisma/client";
import { RideContext } from "../../presentation/controllers/ride.controller";

export type MatchLevel = "REFERRED" | "PARTNER" | "GENERAL";

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

    // Driver indicado já foi tentado → verificar se há parceiros da rede não tentados
    const partnerDrivers = await prisma.driver.findMany({
      where: {
        isActive: true,
        referredByDriverId: referredDriverId,
      },
      select: { id: true },
    });

    if (partnerDrivers.length === 0) return "GENERAL";

    // Verificar se algum parceiro ainda não recebeu offer
    const triedOffers = await prisma.rideOffer.findMany({
      where: { rideRequestId: rideId },
      select: { driverId: true },
    });
    const triedSet = new Set(triedOffers.map((o) => o.driverId));

    const hasUntriedPartner = partnerDrivers.some((d) => !triedSet.has(d.id));

    return hasUntriedPartner ? "PARTNER" : "GENERAL";
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
        return this.execute({ rideId, level: "PARTNER", excludedDriverIds });
      }

      const referredDriver = await prisma.driver.findFirst({
        where: { id: referredDriverId, isActive: true },
      });

      if (!referredDriver) {
        console.log(`⚠️ Driver indicado ${referredDriverId} inativo — escalando para PARTNER`);
        return this.execute({ rideId, level: "PARTNER", excludedDriverIds });
      }

      // ✅ Modo referral: aguarda 60s antes de abrir para outros
      await prisma.rideRequest.update({
        where: { id: rideId },
        data: { status: "WAITING_REFERRAL" },
      });

      await this.createOffer(rideId, referredDriverId, expiresAt);
      console.log(`⏳ Corrida ${rideId} em WAITING_REFERRAL — fallback em ${REFERRAL_TIMEOUT_MS / 1000}s`);
      console.log("Referral timeout iniciado:", rideId);

      // Timeout: se ainda WAITING_REFERRAL após REFERRAL_TIMEOUT_MS → escalar para pool geral
      setTimeout(async () => {
        try {
          const current = await prisma.rideRequest.findUnique({
            where: { id: rideId },
            select: { status: true },
          });
          if (current?.status === "WAITING_REFERRAL") {
            console.log("Referral expirado → fallback MATCHING:", rideId);

            // Expirar offer ainda pendente do driver indicado (evita aceitação tardia)
            await prisma.rideOffer.updateMany({
              where: { rideRequestId: rideId, driverId: referredDriverId, status: "PENDING" },
              data: { status: "EXPIRED" },
            });

            await prisma.rideRequest.update({
              where: { id: rideId },
              data: { status: "MATCHING" },
            });
            await this.execute({
              rideId,
              level: "GENERAL",
              excludedDriverIds: [...excludedDriverIds, referredDriverId],
            });
          }
        } catch (err) {
          console.error(`🔥 Erro no timeout referral para corrida ${rideId}:`, err);
        }
      }, REFERRAL_TIMEOUT_MS);

      return { matched: true, level };
    }

    // ── Tier 2: PARTNER ───────────────────────────────────────────────────────
    if (level === "PARTNER") {
      if (!referredDriverId) {
        return this.execute({ rideId, level: "GENERAL", excludedDriverIds });
      }

      await prisma.rideRequest.update({
        where: { id: rideId },
        data: { status: "MATCHING" },
      });

      const partnerExcluded = [...alreadyOfferedIds, referredDriverId];

      const partnerDriversRaw = await prisma.driver.findMany({
        where: {
          isActive: true,
          id: { notIn: partnerExcluded },
          referredByDriverId: referredDriverId,
        },
        select: { id: true, experienceLevel: true, vehicles: { select: { category: true } } },
      });

      const partnerDrivers = applyContextFilters(partnerDriversRaw, rideContext);

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
    await prisma.rideRequest.update({
      where: { id: rideId },
      data: { status: "MATCHING" },
    });

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
