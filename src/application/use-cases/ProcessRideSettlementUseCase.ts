import { prisma } from "../../infra/prisma/client";
import { logMatchingEvent } from "../../shared/logging/matchingLog";

export interface ProcessRideSettlementInput {
  rideId: string;
}

export class ProcessRideSettlementUseCase {
  async execute(input: ProcessRideSettlementInput): Promise<{ settlementId: string }> {
    const { rideId } = input;

    // 1. Buscar corrida + passageiro para extrair rootDriverId (Invariante 3)
    const ride = await prisma.rideRequest.findUnique({
      where: { id: rideId },
      select: {
        id: true,
        priceOffered: true,
        priceEstimated: true,
        selectedDriverId: true,
        passenger: { select: { rootDriverId: true } },
      },
    });

    if (!ride) {
      throw new Error(`Ride ${rideId} not found`);
    }

    if (!ride.selectedDriverId) {
      throw new Error(`Ride ${rideId} has no selected driver`);
    }

    const rootDriverId = ride.passenger?.rootDriverId ?? ride.selectedDriverId;

    // 2. Calcular valores (Modelo 10%)
    const grossReais = ride.priceOffered ?? ride.priceEstimated ?? 0;
    if (grossReais <= 0) {
      throw new Error(`Invalid gross amount for ride ${rideId}: ${grossReais}`);
    }

    const grossCents = Math.round(grossReais * 100);
    const platformCents = 250; // R$2,50 fixo — taxa Cyborg Tecnologia
    const driverCents = grossCents - platformCents;
    const rootDriverCents = 0; // Root driver não recebe split direto nesta fase

    // 3. Transação atômica: Settlement + RevenueSplits (Invariantes 1, 2, 4)
    const settlement = await prisma.$transaction(async (tx) => {
      // Verificar idempotência
      const existing = await tx.settlement.findUnique({
        where: { rideRequestId: rideId },
      });
      if (existing) return existing;

      // Buscar PaymentIntent para vincular; se não houver (corrida sem PIX / pagamento
      // em dinheiro), cria um intent sintético CONFIRMED para satisfazer o schema.
      const existingIntent = await tx.paymentIntent.findUnique({
        where: { rideRequestId: rideId },
      });
      const paymentIntent = existingIntent ?? await tx.paymentIntent.create({
        data: {
          rideRequestId: rideId,
          amountCents: grossCents,
          status: "CONFIRMED",
          confirmedAt: new Date(),
        },
      });

      // Criar Settlement (Invariantes 1 e 2: entidade única, imutável)
      const s = await tx.settlement.create({
        data: {
          rideRequestId: rideId,
          paymentIntentId: paymentIntent.id,
          totalCents: grossCents,
          driverCents,
          platformCents,
          rootDriverCents,
          rootDriverId,
        },
      });

      // Criar RevenueSplits (Invariante 4: Σ splits = settlement.amount)
      await tx.revenueSplit.createMany({
        data: [
          {
            settlementId: s.id,
            beneficiaryType: "PLATFORM",
            amountCents: platformCents,
            percentBps: Math.round((platformCents / grossCents) * 10000),
          },
          {
            settlementId: s.id,
            beneficiaryType: "DRIVER",
            beneficiaryDriverId: ride.selectedDriverId,
            amountCents: driverCents,
            percentBps: Math.round((driverCents / grossCents) * 10000),
          },
        ],
      });

      return s;
    });

    // 4. Telemetria
    logMatchingEvent({
      rideId,
      event: "RIDE_COMPLETED",
      metadata: {
        settlementId: settlement.id,
        grossCents,
        platformCents,
        driverCents,
        rootDriverId,
      },
    });

    return { settlementId: settlement.id };
  }
}