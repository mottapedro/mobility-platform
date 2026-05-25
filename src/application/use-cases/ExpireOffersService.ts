import { prisma } from "../../infra/prisma/client";
import { MatchRideUseCase } from "./MatchRideUseCase";
import { AcceptancePolicyEngine } from "../../domain/services/AcceptancePolicyEngine";
import { logMatchingEvent } from "../../shared/logging/matchingLog";

export class ExpireOffersService {
  async execute(): Promise<void> {
    const now = new Date();

    const expiredOffers = await prisma.rideOffer.findMany({
      where: {
        status: "PENDING",
        expiresAt: { lt: now },
      },
      select: { id: true, rideRequestId: true },
    });

    if (expiredOffers.length === 0) return;

    const offerIds = expiredOffers.map((o) => o.id);
    const rideIds = [...new Set(expiredOffers.map((o) => o.rideRequestId))];

    await prisma.rideOffer.updateMany({
      where: { id: { in: offerIds } },
      data: { status: "EXPIRED" },
    });

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
        status: { notIn: ["EXPIRED", "REJECTED"] },
      },
      _count: true,
    });

    const activeRideSet = new Set(
      ridesWithActiveOffers.map((r) => r.rideRequestId)
    );

    // Corridas sem offers ativas: tentar re-match antes de expirar
    const ridesToRematch = rideIds.filter((id) => !activeRideSet.has(id));

    if (ridesToRematch.length === 0) return;

    // Excluir corridas em WAITING_REFERRAL — o timeout de 60s já trata o fallback delas
    const waitingReferralRides = await prisma.rideRequest.findMany({
      where: { id: { in: ridesToRematch }, status: "WAITING_REFERRAL" },
      select: { id: true },
    });
    const waitingSet = new Set(waitingReferralRides.map((r) => r.id));
    const rematchCandidates = ridesToRematch.filter((id) => !waitingSet.has(id));

    if (rematchCandidates.length === 0) return;

    const matchRide = new MatchRideUseCase();
    const expiredRideIds: string[] = [];

    for (const rideId of rematchCandidates) {
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
      const { matched } = await matchRide.execute({ rideId });

      if (!matched) {
        expiredRideIds.push(rideId);
      }
    }

    // Só expira as corridas que não encontraram nenhum driver disponível
    if (expiredRideIds.length > 0) {
      await prisma.rideRequest.updateMany({
        where: {
          id: { in: expiredRideIds },
          status: { in: ["PENDING", "MATCHING", "WAITING_DRIVER"] },
        },
        data: { status: "EXPIRED" },
      });

      console.log(`❌ ${expiredRideIds.length} corrida(s) expirada(s) — sem drivers disponíveis`);
    }
  }
}
