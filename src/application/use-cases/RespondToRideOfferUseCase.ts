import { prisma } from "../../infra/prisma/client";
import { Prisma } from "@prisma/client";
import { MatchRideUseCase } from "./MatchRideUseCase";
import { AcceptancePolicyEngine } from "../../domain/services/AcceptancePolicyEngine";
import { logMatchingEvent } from "../../shared/logging/matchingLog";
import { GeneratePaymentIntentUseCase } from "./GeneratePaymentIntentUseCase";

export class OfferResponseError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "OfferResponseError";
  }
}

export class RespondToRideOfferUseCase {

  async execute(offerId: string, accept: boolean): Promise<{ accepted: boolean; paymentIntent?: { id: string; brCode: string; qrCodeUrl: string } | null }> {

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
          data: { status: "REJECTED" },
        });

        await tx.rideRequest.update({
          where: { id: offer.rideRequestId },
          data: {
            status: "ACCEPTED",
            selectedDriverId: offer.driverId,
            // Phase 2: clear queue state on terminal accept.
            currentCandidateDriverId: null,
            queueSnapshot: Prisma.DbNull,
          },
        });
      });

      console.log(`✅ Corrida ${offer.rideRequestId} aceita pelo driver ${offer.driverId}`);

      // Generate PaymentIntent (mock Pix) after successful accept
      const paymentIntentUseCase = new GeneratePaymentIntentUseCase();
      const paymentIntent = await paymentIntentUseCase.execute({ rideId: offer.rideRequestId });

      return { accepted: true, paymentIntent };

    } else {
      const ride = await prisma.rideRequest.findUnique({
        where: { id: offer.rideRequestId },
        select: {
          status: true,
          scheduledAt: true,
          operationalCutoffAt: true,
          currentDispatchStage: true,
          passenger: { select: { referredByDriverId: true } },
        },
      });

      await prisma.rideOffer.update({
        where: { id: offerId },
        data: { status: "REJECTED", respondedAt: now },
      });

      // Phase 2: append rejecting driver to persisted exclusion list and clear
      // the current candidate pointer atomically so the next dispatchNextCandidate
      // call cannot re-offer to the same driver.
      await prisma.rideRequest.update({
        where: { id: offer.rideRequestId },
        data: {
          excludedDriverIds: { push: offer.driverId },
          currentCandidateDriverId: null,
        },
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
          data: { status: "CANCELLED" },
        });
        return { accepted: false };
      }

      // If owner rejects, move to network dispatch
      if (ride?.currentDispatchStage === "OWNER_DISPATCH") {
        await prisma.rideRequest.update({
          where: { id: offer.rideRequestId },
          data: { currentDispatchStage: "NETWORK_DISPATCH" },
        });
      }

      const matchRide = new MatchRideUseCase();
      const { matched } = await matchRide.dispatchNextCandidate({ rideId: offer.rideRequestId });

      logMatchingEvent({
        rideId: offer.rideRequestId,
        event: "OFFER_REDISTRIBUTED",
        metadata: { matched },
      });

      if (!matched) {
        // If no more candidates, move to OWNER_RECOVERY
        await prisma.rideRequest.update({
          where: {
            id: offer.rideRequestId,
            currentDispatchStage: "NETWORK_DISPATCH",
          },
          data: { currentDispatchStage: "OWNER_RECOVERY" },
        });
      }
    }

    return { accepted: accept };
  }
}
