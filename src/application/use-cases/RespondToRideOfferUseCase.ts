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
      await prisma.$transaction([
        prisma.rideOffer.update({
          where: { id: offerId },
          data: { status: "ACCEPTED", respondedAt: now },
        }),
        prisma.rideOffer.updateMany({
          where: {
            rideRequestId: offer.rideRequestId,
            id: { not: offerId },
            status: "PENDING",
          },
          data: { status: "EXPIRED" },
        }),
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
      const ride = await prisma.rideRequest.findUnique({
        where: { id: offer.rideRequestId },
        select: {
          status: true,
          passenger: { select: { referredByDriverId: true } },
        },
      });

      await prisma.rideOffer.update({
        where: { id: offerId },
        data: { status: "REJECTED", respondedAt: now },
      });

      console.log("Driver " + offer.driverId + " rejeitou a corrida " + offer.rideRequestId);

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
          const { matched } = await matchRide.execute({ rideId: offer.rideRequestId });

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
