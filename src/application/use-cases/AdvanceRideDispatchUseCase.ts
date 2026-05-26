import { prisma } from "../../infra/prisma/client";
import { logInfo } from "../../shared/logger";
import { MatchRideUseCase } from "./MatchRideUseCase";

interface AdvanceRideDispatchInput {
  rideId: string;
  excludedDriverIds?: string[];
}

export class AdvanceRideDispatchUseCase {
  async execute(input: AdvanceRideDispatchInput): Promise<{ advanced: boolean; expired: boolean }> {
    const { rideId, excludedDriverIds = [] } = input;

    const ride = await prisma.rideRequest.findUnique({
      where: { id: rideId },
      select: {
        id: true,
        status: true,
        selectedDriverId: true,
        passenger: { select: { referredByDriverId: true } },
      },
    });

    if (!ride) {
      return { advanced: false, expired: false };
    }

    if (
      ride.selectedDriverId ||
      ["ACCEPTED", "EXPIRED", "CANCELLED", "COMPLETED"].includes(ride.status)
    ) {
      return { advanced: false, expired: false };
    }

    const pendingOffers = await prisma.rideOffer.count({
      where: { rideRequestId: rideId, status: "PENDING" },
    });

    if (pendingOffers > 0) {
      return { advanced: false, expired: false };
    }

    const nextExcludedDriverIds = [...excludedDriverIds];
    if (ride.status === "WAITING_REFERRAL" && ride.passenger.referredByDriverId) {
      nextExcludedDriverIds.push(ride.passenger.referredByDriverId);
    }

    const matchRideUseCase = new MatchRideUseCase();
    const { matched } = await matchRideUseCase.execute({
      rideId,
      level: "GENERAL",
      excludedDriverIds: [...new Set(nextExcludedDriverIds)],
    });

    if (matched) {
      logInfo("ride.dispatch.advanced", {
        rideId,
        nextStage: "GENERAL",
      });
      return { advanced: true, expired: false };
    }

    const expiredRide = await prisma.rideRequest.updateMany({
      where: {
        id: rideId,
        selectedDriverId: null,
        status: { in: ["PENDING", "MATCHING", "WAITING_REFERRAL"] },
      },
      data: { status: "EXPIRED" },
    });

    if (expiredRide.count > 0) {
      logInfo("ride.dispatch.exhausted", { rideId });
      return { advanced: false, expired: true };
    }

    return { advanced: false, expired: false };
  }
}