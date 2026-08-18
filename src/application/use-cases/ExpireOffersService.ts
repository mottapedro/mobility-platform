import { RideOfferStatus } from "@prisma/client";
import { prisma } from "../../infra/prisma/client";
import { MatchRideUseCase } from "./MatchRideUseCase";
import { AcceptancePolicyEngine } from "../../domain/services/AcceptancePolicyEngine";
import { logMatchingEvent } from "../../shared/logging/matchingLog";

export class ExpireOffersService {
  async execute(): Promise<void> {
    const now = new Date();

    const expiredOffers = await prisma.rideOffer.findMany({
      where: {
        status: RideOfferStatus.PENDING,
        expiresAt: { lt: now },
      },
      select: { id: true, rideRequestId: true, driverId: true },
    });

    if (expiredOffers.length === 0) return;

    const offerIds = expiredOffers.map((o) => o.id);
    const rideIds = [...new Set(expiredOffers.map((o) => o.rideRequestId))];

    await prisma.rideOffer.updateMany({
      where: { id: { in: offerIds } },
      data: { status: RideOfferStatus.EXPIRED },
    });

    // Phase 2: persist the rejection of each expired candidate on the parent
    // RideRequest so dispatchNextCandidate cannot re-offer to them. Done per
    // ride so we can also clear currentCandidateDriverId when it matches.
    const ridesAffected = await prisma.rideRequest.findMany({
      where: { id: { in: rideIds } },
      select: { id: true, currentCandidateDriverId: true, excludedDriverIds: true },
    });
    for (const r of ridesAffected) {
      const expiredDriverIds = expiredOffers
        .filter((o) => o.rideRequestId === r.id)
        .map((o) => o.driverId);
      const existing = new Set(r.excludedDriverIds ?? []);
      const additions = expiredDriverIds.filter((id) => !existing.has(id));
      if (additions.length === 0 && r.currentCandidateDriverId === null) continue;
      await prisma.rideRequest.update({
        where: { id: r.id },
        data: {
          excludedDriverIds: { push: additions },
          currentCandidateDriverId:
            r.currentCandidateDriverId && expiredDriverIds.includes(r.currentCandidateDriverId)
              ? null
              : r.currentCandidateDriverId,
          lastOfferExpiredAt: now,
        },
      });
    }

    offerIds.forEach((id) => {
      const rideId = expiredOffers.find((o) => o.id === id)!.rideRequestId;
      logMatchingEvent({ rideId, event: "OFFER_EXPIRED", metadata: { offerId: id } });
    });

    console.log(`⏱️ ${offerIds.length} offer(s) expirada(s)`);

    // Para cada corrida afetada, verificar se há offers ativas — se não, tentar re-match
    const ridesWithActiveOffers = await prisma.rideOffer.groupBy({
      by: ["rideRequestId"],
      where: {
        rideRequestId: { in: rideIds },
        status: { in: ["PENDING"] },
      },
      _count: true,
    });

    const activeRideSet = new Set(
      ridesWithActiveOffers.map((r) => r.rideRequestId)
    );

    // Corridas sem offers ativas: tentar re-match antes de expirar
    const ridesToRematch = rideIds.filter((id) => !activeRideSet.has(id));

    if (ridesToRematch.length === 0) return;

    // In Model B, all dispatch happens while status=REQUESTED, so no need to
    // exclude WAITING_REFERRAL (which doesn't exist). Dispatch stages are tracked
    // via dispatchStage field.

    const matchRide = new MatchRideUseCase();
    const expiredRideIds: string[] = [];

    for (const rideId of ridesToRematch) {
      // Check operational cutoff before attempting re-match.
      const ride = await prisma.rideRequest.findUnique({
        where: { id: rideId },
        select: { scheduledAt: true, operationalCutoffAt: true },
      });

      const policy = AcceptancePolicyEngine.computePolicy(
        ride?.scheduledAt ?? null
      );

      if (AcceptancePolicyEngine.isBeyondCutoff(now, policy)) {
        logMatchingEvent({
          rideId,
          event: "OPERATIONAL_CUTOFF_REACHED",
          metadata: { operationalCutoffAt: policy.operationalCutoffAt?.toISOString() },
        });
        expiredRideIds.push(rideId);
        continue;
      }

      console.log(`🔄 Re-match automático para corrida ${rideId}...`);
      logMatchingEvent({ rideId, event: "OFFER_REDISTRIBUTED" });
      const { matched } = await matchRide.dispatchNextCandidate({ rideId });

      if (!matched) {
        expiredRideIds.push(rideId);
      }
    }

    // Só expira as corridas que não encontraram nenhum driver disponível
    if (expiredRideIds.length > 0) {
      await prisma.rideRequest.updateMany({
        where: {
          id: { in: expiredRideIds },
          status: "PENDING",
        },
        data: { status: "CANCELLED" },
      });

      console.log(`❌ ${expiredRideIds.length} corrida(s) expirada(s) — sem drivers disponíveis`);
    }
  }
}
