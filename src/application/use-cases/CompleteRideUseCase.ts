import { prisma } from "../../infra/prisma/client";
import { logMatchingEvent } from "../../shared/logging/matchingLog";
import { ProcessRideSettlementUseCase } from "./ProcessRideSettlementUseCase";

export interface CompleteRideInput {
  rideId: string;
  driverId: string;
}

export class CompleteRideUseCase {
  async execute(input: CompleteRideInput): Promise<{ success: boolean; rideId: string }> {
    const { rideId, driverId } = input;

    // 1. Validar existência e estado
    const ride = await prisma.rideRequest.findUnique({
      where: { id: rideId },
      select: { id: true, selectedDriverId: true, status: true },
    });

    if (!ride) {
      throw new Error(`Ride ${rideId} not found`);
    }

    // 2. Autorização: apenas o motorista designado pode finalizar a corrida
    if (ride.selectedDriverId !== driverId) {
      throw new Error("Unauthorized: Only the assigned driver can complete this ride");
    }

    // 3. Pré-condição de estado
    if (ride.status !== "IN_PROGRESS") {
      throw new Error(`Invalid ride status: ${ride.status}. Expected IN_PROGRESS to complete.`);
    }

    // 4. Transição de estado
    await prisma.rideRequest.update({
      where: { id: rideId },
      data: { status: "COMPLETED" },
    });

    // 5. Processar liquidação financeira (Modelo 10%)
    const settlementUseCase = new ProcessRideSettlementUseCase();
    const { settlementId } = await settlementUseCase.execute({ rideId });

    // 6. Telemetria
    logMatchingEvent({
      rideId,
      event: "RIDE_COMPLETED",
      metadata: { driverId, settlementId },
    });

    return { success: true, rideId };
  }
}
