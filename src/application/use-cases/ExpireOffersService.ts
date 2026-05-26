import { prisma } from "../../infra/prisma/client";
import { logInfo } from "../../shared/logger";
import { AdvanceRideDispatchUseCase } from "./AdvanceRideDispatchUseCase";

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
      data: { status: "EXPIRED", respondedAt: now },
    });

    logInfo("ride.dispatch.offers_expired", { offerCount: offerIds.length, rideIds });

    const advanceRideDispatchUseCase = new AdvanceRideDispatchUseCase();
    for (const rideId of rideIds) {
      await advanceRideDispatchUseCase.execute({ rideId });
    }
  }
}
