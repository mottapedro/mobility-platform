import { prisma } from "../../infra/prisma/client";
import { MatchRideUseCase } from "./MatchRideUseCase";

export class RespondToRideOfferUseCase {

  async execute(offerId: string, accept: boolean) {

    const offer = await prisma.rideOffer.findUnique({
      where: { id: offerId }
    });

    if (!offer) throw new Error("Offer not found");

    if (accept) {

      await prisma.rideOffer.update({
        where: { id: offerId },
        data: {
          status: "ACCEPTED",
          respondedAt: new Date()
        }
      });

      await prisma.rideRequest.update({
        where: { id: offer.rideRequestId },
        data: {
          status: "ACCEPTED",
          selectedDriverId: offer.driverId
        }
      });

    } else {

      await prisma.rideOffer.update({
        where: { id: offerId },
        data: {
          status: "REJECTED",
          respondedAt: new Date()
        }
      });

      const match = new MatchRideUseCase();
      await match.execute(offer.rideRequestId);
    }
  }
}