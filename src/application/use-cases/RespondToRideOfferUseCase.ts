import { prisma } from "../../infra/prisma/client";
import { MatchRideUseCase } from "./MatchRideUseCase";

export class OfferResponseError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "OfferResponseError";
  }
}

export class RespondToRideOfferUseCase {

  async execute(offerId: string, accept: boolean): Promise<{ accepted: boolean }> {

    // 1. Buscar offer
    const offer = await prisma.rideOffer.findUnique({
      where: { id: offerId },
    });

    if (!offer) {
      throw new OfferResponseError("OFFER_NOT_FOUND", "Offer não encontrada");
    }

    // 2. Validar status — só pode responder offers PENDING
    if (offer.status !== "PENDING") {
      throw new OfferResponseError(
        "OFFER_ALREADY_RESPONDED",
        `Offer já foi respondida com status: ${offer.status}`
      );
    }

    // 3. Validar expiração
    if (new Date() > offer.expiresAt) {
      throw new OfferResponseError("OFFER_EXPIRED", "Offer já expirou");
    }

    const now = new Date();

    if (accept) {
      // ✅ ACCEPT — transação atômica
      await prisma.$transaction([
        // Marcar esta offer como ACCEPTED
        prisma.rideOffer.update({
          where: { id: offerId },
          data: { status: "ACCEPTED", respondedAt: now },
        }),
        // Expirar todas as outras offers PENDING da mesma corrida
        prisma.rideOffer.updateMany({
          where: {
            rideRequestId: offer.rideRequestId,
            id: { not: offerId },
            status: "PENDING",
          },
          data: { status: "EXPIRED" },
        }),
        // Corrida → ACCEPTED com driver selecionado
        prisma.rideRequest.update({
          where: { id: offer.rideRequestId },
          data: {
            status: "ACCEPTED",
            selectedDriverId: offer.driverId,
          },
        }),
      ]);

      console.log(`✅ Corrida ${offer.rideRequestId} aceita pelo driver ${offer.driverId}`);

    } else {
      // ❌ REJECT — transação para rejeitar a offer
      await prisma.$transaction([
        prisma.rideOffer.update({
          where: { id: offerId },
          data: { status: "REJECTED", respondedAt: now },
        }),
      ]);

      console.log(`❌ Driver ${offer.driverId} rejeitou a corrida ${offer.rideRequestId}, tentando re-match...`);

      // Só re-match quando não houver mais offers PENDING para esta corrida
      // (evita escalar de tier enquanto outros drivers ainda têm offer ativa)
      const pendingCount = await prisma.rideOffer.count({
        where: { rideRequestId: offer.rideRequestId, status: "PENDING" },
      });

      if (pendingCount === 0) {
        const matchRide = new MatchRideUseCase();
        const { matched } = await matchRide.execute({ rideId: offer.rideRequestId });

        if (!matched) {
          await prisma.rideRequest.update({
            where: {
              id: offer.rideRequestId,
              status: { in: ["PENDING", "MATCHING"] },
            },
            data: { status: "EXPIRED" },
          });
          console.log(`⏱️ Corrida ${offer.rideRequestId} expirada — sem drivers disponíveis`);
        }
      } else {
        console.log(`⏳ Corrida ${offer.rideRequestId} aguardando ${pendingCount} offer(s) pendente(s)`);
      }
    }

    return { accepted: accept };
  }
}
