import { prisma } from "../../infra/prisma/client";
import { logMatchingEvent } from "../../shared/logging/matchingLog";

export interface RescheduleInput {
  rideId: string;
  newScheduledAt: Date;
  newOrigin?: string;
  newDestination?: string;
  requestingDriverId: string;
}

export class RescheduleRideUseCase {
  async execute(input: RescheduleInput): Promise<{ success: boolean; rideId: string }> {
    const { rideId, newScheduledAt, newOrigin, newDestination, requestingDriverId } = input;

    // 1. Validar existência
    const ride = await prisma.rideRequest.findUnique({
      where: { id: rideId },
      select: { id: true, rootDriverId: true, status: true },
    });

    if (!ride) {
      throw new Error(`Ride ${rideId} not found`);
    }

    // 2. Ownership validation — apenas o root driver pode reagendar
    if (ride.rootDriverId !== requestingDriverId) {
      throw new Error("Unauthorized: Only the root driver can reschedule this ride");
    }

    // 3. Montar dados de atualização
    const data: Record<string, unknown> = {
      scheduledAt: newScheduledAt,
      excludedDriverIds: [],
      currentDispatchStage: "OWNER_DISPATCH",
    };

    if (newOrigin !== undefined) data.origin = newOrigin;
    if (newDestination !== undefined) data.destination = newDestination;

    // 4. Executar update
    await prisma.rideRequest.update({
      where: { id: rideId },
      data,
    });

    // 5. Telemetria
    logMatchingEvent({
      rideId,
      event: "RIDE_RESCHEDULED",
      metadata: {
        newScheduledAt: newScheduledAt.toISOString(),
        ...(newOrigin && { newOrigin }),
        ...(newDestination && { newDestination }),
        rootDriverId: requestingDriverId,
      },
    });

    return { success: true, rideId };
  }
}