// EnsureFirstOfferService — emissão idempotente da primeira oferta (Fase E).
//
// Conecta a RideQuote AGREED (precificação congelada) à primeira RideOffer:
// a oferta copia o snapshot da quote (M→A, A→B e recebível) e a corrida
// transiciona para WAITING_REFERRAL/REFERRAL_DIRECT com o M1 como candidato.
//
// Guardas:
//   - Nenhuma oferta PENDING já existente (invariante 1-active-pending).
//   - Status da corrida matchable (PENDING) — CAS evita sobrescrever aceite.
//   - Quote obrigatória: sem quote AGREED a oferta não é emitida (a corrida
//     segue o fluxo clássico via MatchRideUseCase).

import { prisma } from "../../infra/prisma/client";
import { MATCHABLE_RIDE_STATUSES } from "../use-cases/MatchRideUseCase";
import { execute as createOfferService } from "./CreateOfferService";
import { AcceptancePolicyEngine } from "../../domain/services/AcceptancePolicyEngine";

export type EnsureFirstOfferResult =
  | { offered: true; offerId: string }
  | { offered: false; reason: "RIDE_NOT_MATCHABLE" | "PENDING_OFFER_EXISTS" | "NO_AGREED_QUOTE" };

/**
 * Garante a primeira oferta de uma corrida M1 com quote AGREED.
 * Idempotente: se a oferta já existe, não cria duplicata.
 */
export class EnsureFirstOfferService {
  async execute(rideId: string): Promise<EnsureFirstOfferResult> {
    const ride = await prisma.rideRequest.findUnique({
      where: { id: rideId },
      include: { offers: { where: { status: "PENDING" }, select: { id: true } } },
    });

    if (!ride) {
      throw new Error(`Ride ${rideId} not found`);
    }

    if (!MATCHABLE_RIDE_STATUSES.some((s) => s === ride.status)) {
      return { offered: false, reason: "RIDE_NOT_MATCHABLE" };
    }

    if (ride.offers.length > 0) {
      return { offered: false, reason: "PENDING_OFFER_EXISTS" };
    }

    // A quote é a fonte canônica do snapshot da oferta.
    const quote = await prisma.rideQuote.findFirst({
      where: { rideRequestId: rideId, status: "AGREED" },
      orderBy: { createdAt: "desc" },
    });

    if (!quote) {
      return { offered: false, reason: "NO_AGREED_QUOTE" };
    }

    const now = new Date();
    const policy = AcceptancePolicyEngine.computePolicy(
      ride.scheduledAt ?? null,
      true, // rede (M1)
    );
    const expiresAt = AcceptancePolicyEngine.computeOfferExpiry(now, policy);

    const result = await createOfferService({
      rideRequestId: rideId,
      driverId: quote.pricingDriverId,
      expiresAt,
      driverToPickupDistanceKm: quote.distanceMtoAKm,
      rideDistanceKm: quote.distanceAtoBKm,
      driverReceivableAmountCents: quote.driverReceivableAmountCents,
    });

    if (result.created) {
      const rideUpdated = await prisma.rideRequest.updateMany({
        where: { id: rideId, status: { in: [...MATCHABLE_RIDE_STATUSES] } },
        data: {
          status: "WAITING_REFERRAL",
          currentDispatchStage: "REFERRAL_DIRECT",
          currentCandidateDriverId: quote.pricingDriverId,
        },
      });

      if (rideUpdated.count === 0) {
        await prisma.rideOffer.updateMany({
          where: { id: result.offer.id, status: "PENDING" },
          data: { status: "EXPIRED" },
        });
        return { offered: false, reason: "RIDE_NOT_MATCHABLE" };
      }

      return { offered: true, offerId: result.offer.id };
    }

    return {
      offered: false,
      reason: "PENDING_OFFER_EXISTS",
    };
  }
}