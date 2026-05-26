import { prisma } from "../../infra/prisma/client";
import { logInfo } from "../../shared/logger";
import { AdvanceRideDispatchUseCase } from "./AdvanceRideDispatchUseCase";

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

    if (offer.status === "EXPIRED" || new Date() > offer.expiresAt) {
      throw new OfferResponseError("OFFER_EXPIRED", "Offer ja expirou");
    }

    if (offer.status !== "PENDING") {
      throw new OfferResponseError(
        "OFFER_ALREADY_RESPONDED",
        "Offer ja foi respondida com status: " + offer.status
      );
    }

    const now = new Date();

    if (accept) {
      await prisma.$transaction(async (tx) => {
        const offerAccepted = await tx.rideOffer.updateMany({
          where: {
            id: offerId,
            status: "PENDING",
            expiresAt: { gt: now },
          },
          data: { status: "ACCEPTED", respondedAt: now },
        });

        if (offerAccepted.count === 0) {
          throw new OfferResponseError("OFFER_EXPIRED", "Offer ja expirou");
        }

        const rideAccepted = await tx.rideRequest.updateMany({
          where: {
            id: offer.rideRequestId,
            selectedDriverId: null,
            status: { in: ["PENDING", "MATCHING", "WAITING_REFERRAL", "WAITING_DRIVER"] },
          },
          data: {
            status: "ACCEPTED",
            selectedDriverId: offer.driverId,
          },
        });

        if (rideAccepted.count === 0) {
          throw new OfferResponseError("OFFER_ALREADY_RESPONDED", "Corrida ja foi atribuida");
        }

        await tx.rideOffer.updateMany({
          where: {
            rideRequestId: offer.rideRequestId,
            id: { not: offerId },
            status: "PENDING",
          },
          data: { status: "EXPIRED", respondedAt: now },
        });
      });

      logInfo("ride.dispatch.offer_accepted", {
        rideId: offer.rideRequestId,
        driverId: offer.driverId,
        offerId,
      });

    } else {
      const rejected = await prisma.rideOffer.updateMany({
        where: {
          id: offerId,
          status: "PENDING",
          expiresAt: { gt: now },
        },
        data: { status: "REJECTED", respondedAt: now },
      });

      if (rejected.count === 0) {
        throw new OfferResponseError("OFFER_EXPIRED", "Offer ja expirou");
      }

      logInfo("ride.dispatch.offer_rejected", {
        rideId: offer.rideRequestId,
        driverId: offer.driverId,
        offerId,
      });

      const advanceRideDispatchUseCase = new AdvanceRideDispatchUseCase();
      await advanceRideDispatchUseCase.execute({
        rideId: offer.rideRequestId,
        excludedDriverIds: [offer.driverId],
      });
    }

    return { accepted: accept };
  }
}
