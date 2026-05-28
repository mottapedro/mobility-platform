import { prisma } from "../../infra/prisma/client";
import { MatchRideUseCase } from "./MatchRideUseCase";
import { AcceptancePolicyEngine } from "../../domain/services/AcceptancePolicyEngine";
import { logMatchingEvent } from "../../shared/logging/matchingLog";

export class OfferResponseError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "OfferResponseError";
  }
}

export class RespondToRideOfferUseCase {

  async execute(offerId: string, accept: boolean): Promise<{ accepted: boolean }> {

    const offer = await prisma.rideOffer.findUnique({
      where: { id: offerId },
    });

    if (!offer) {
      throw new OfferResponseError("OFFER_NOT_FOUND", "Offer nao encontrada");
    }

    if (offer.status !== "PENDING") {
      throw new OfferResponseError(
        "OFFER_ALREADY_RESPONDED",
        "Offer ja foi respondida com status: " + offer.status
      );
    }

    if (new Date() > offer.expiresAt) {
      throw new OfferResponseError("OFFER_EXPIRED", "Offer ja expirou");
    }

    const now = new Date();

    if (accept) {
      await prisma.$transaction(async (tx) => {
        await tx.rideOffer.update({
          where: { id: offerId },
          data: { status: "ACCEPTED", respondedAt: now },
        });

        await tx.rideOffer.updateMany({
          where: {
            rideRequestId: offer.rideRequestId,
            id: { not: offerId },
            status: "PENDING",
          },
          data: { status: "EXPIRED" },
        });

        await tx.rideRequest.update({
          where: { id: offer.rideRequestId },
          data: {
            status: "ACCEPTED",
            selectedDriverId: offer.driverId,
          },
        });
      });

      console.log(`✅ Corrida ${offer.rideRequestId} aceita pelo driver ${offer.driverId}`);

    } else {
      const ride = await prisma.rideRequest.findUnique({
        where: { id: offer.rideRequestId },
        select: {
          status: true,
          scheduledAt: true,
          operationalCutoffAt: true,
          passenger: { select: { referredByDriverId: true } },
        },
      });

      await prisma.rideOffer.update({
        where: { id: offerId },
        data: { status: "REJECTED", respondedAt: now },
      });

      logMatchingEvent({
        rideId: offer.rideRequestId,
        event: "OFFER_REJECTED",
        metadata: { driverId: offer.driverId },
      });
      console.log("Driver " + offer.driverId + " rejeitou a corrida " + offer.rideRequestId);

      // Check operational cutoff before redistribution.
      const policy = AcceptancePolicyEngine.computePolicy(ride?.scheduledAt ?? null);
      if (AcceptancePolicyEngine.isBeyondCutoff(new Date(), policy)) {
        logMatchingEvent({
          rideId: offer.rideRequestId,
          event: "OPERATIONAL_CUTOFF_REACHED",
          metadata: { operationalCutoffAt: policy.operationalCutoffAt?.toISOString() },
        });
        await prisma.rideRequest.update({
          where: { id: offer.rideRequestId },
          data: { status: "EXPIRED" },
        });
        return { accepted: false };
      }

      const isWaitingReferral = ride?.status === "WAITING_REFERRAL";
      const isReferredDriver  = ride?.passenger?.referredByDriverId === offer.driverId;

      if (isWaitingReferral && isReferredDriver) {
        await prisma.rideRequest.update({
          where: { id: offer.rideRequestId },
          data: { status: "MATCHING" },
        });

        const matchRide = new MatchRideUseCase();
        const { matched } = await matchRide.execute({
          rideId: offer.rideRequestId,
          level: "NETWORK_L1",
          excludedDriverIds: [offer.driverId],
        });

        logMatchingEvent({
          rideId: offer.rideRequestId,
          event: "OFFER_REDISTRIBUTED",
          metadata: { matched, fromLevel: "WAITING_REFERRAL" },
        });

        if (!matched) {
          await prisma.rideRequest.update({
            where: { id: offer.rideRequestId },
            data: { status: "EXPIRED" },
          });
        }
      } else {
        const pendingCount = await prisma.rideOffer.count({
          where: { rideRequestId: offer.rideRequestId, status: "PENDING" },
        });

        if (pendingCount === 0) {
          const matchRide = new MatchRideUseCase();
          const { matched } = await matchRide.dispatchNextCandidate({ rideId: offer.rideRequestId });

          logMatchingEvent({
            rideId: offer.rideRequestId,
            event: "OFFER_REDISTRIBUTED",
            metadata: { matched },
          });

          if (!matched) {
            await prisma.rideRequest.update({
              where: {
                id: offer.rideRequestId,
                status: { in: ["PENDING", "MATCHING", "WAITING_REFERRAL"] },
              },
              data: { status: "EXPIRED" },
            });
          }
        }
      }
    }

    return { accepted: accept };
  }
}
