import { prisma } from "../../infra/prisma/client";
import { logMatchingEvent } from "../../shared/logging/matchingLog";
import { PaymentStatus } from "../../shared/enums";

export interface StartRideInput {
  rideId: string;
  driverId: string;
}

export class StartRideUseCase {
  async execute(input: StartRideInput): Promise<{ success: boolean; rideId: string }> {
    const { rideId, driverId } = input;

    // 1. Validar existência e estado
    const ride = await prisma.rideRequest.findUnique({
      where: { id: rideId },
      select: { id: true, selectedDriverId: true, status: true },
    });

    if (!ride) {
      throw new Error(`Ride ${rideId} not found`);
    }

    // 2. Autorização: apenas o motorista designado pode iniciar a corrida
    if (ride.selectedDriverId !== driverId) {
      throw new Error("Unauthorized: Only the assigned driver can start this ride");
    }

    // 3. Pré-condição de estado
    if (ride.status !== "ACCEPTED") {
      throw new Error(`Invalid ride status: ${ride.status}. Expected ACCEPTED to start.`);
    }

    // 3.1 Trava de pagamento: exige PaymentIntent confirmado para iniciar
    const paymentIntent = await prisma.paymentIntent.findFirst({
      where: { rideRequestId: rideId },
      select: { id: true, status: true },
    });

    if (!paymentIntent) {
      throw new Error("PaymentIntentNotFound: Nenhuma intenção de pagamento encontrada para esta corrida.");
    }

    if (paymentIntent.status !== PaymentStatus.CONFIRMED) {
      throw new Error("Unauthorized: Payment has not been confirmed yet");
    }

    // 4. Transição de estado
    await prisma.rideRequest.update({
      where: { id: rideId },
      data: { status: "IN_PROGRESS" },
    });

    // 5. Telemetria
    logMatchingEvent({
      rideId,
      event: "RIDE_STARTED",
      metadata: { driverId },
    });

    return { success: true, rideId };
  }
}