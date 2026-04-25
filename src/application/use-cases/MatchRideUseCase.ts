import { prisma } from "../../infra/prisma/client";

export type MatchLevel = "REFERRED" | "PARTNER" | "GENERAL";

export interface MatchInput {
  rideId: string;
  level?: MatchLevel;
  excludedDriverIds?: string[];
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
    if (!["PENDING", "MATCHING"].includes(ride.status)) {
      console.log(`⚠️ Corrida ${rideId} ignorada — status: ${ride.status}`);
      return { matched: false, level: "GENERAL" };
    }

    const referredDriverId = ride.passenger.referredByDriverId ?? null;

    // 2. Derivar nível se não fornecido
    const level = input.level ?? (await this.deriveLevel(rideId, referredDriverId));

    console.log(`🚀 Matching iniciado (${level}) para corrida ${rideId}`);

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
        // Sem indicação → escalar direto para GENERAL
        return this.execute({ rideId, level: "GENERAL", excludedDriverIds });
      }

      if (alreadyOfferedIds.has(referredDriverId)) {
        // Já foi tentado → escalar para PARTNER
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

      // Buscar drivers da rede do driver indicado (referredDrivers)
      const partnerExcluded = [...alreadyOfferedIds, referredDriverId];

      const partnerDrivers = await prisma.driver.findMany({
        where: {
          isActive: true,
          id: { notIn: partnerExcluded },
          referredByDriverId: referredDriverId,
        },
        select: { id: true },
      });

      console.log(`🤝 Drivers parceiros encontrados: ${partnerDrivers.length}`);

      if (partnerDrivers.length === 0) {
        console.log(`⚠️ Nenhum parceiro disponível — escalando para GENERAL`);
        return this.execute({ rideId, level: "GENERAL", excludedDriverIds });
      }

      // Envio em lote para todos os parceiros do tier
      for (const driver of partnerDrivers) {
        await this.createOffer(rideId, driver.id, expiresAt);
      }
      return { matched: true, level };
    }

    // ── Tier 3: GENERAL ───────────────────────────────────────────────────────
    const generalDrivers = await prisma.driver.findMany({
      where: {
        isActive: true,
        id: { notIn: [...alreadyOfferedIds] },
      },
      select: { id: true },
    });

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
