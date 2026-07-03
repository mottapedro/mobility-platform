import { prisma } from "../../infra/prisma/client";
import { getEventBus, getPixProvider } from "../../infrastructure/composition/paymentComposition";
import { createPaymentIntent } from "../../domain/payment/PaymentIntentService";

export interface GeneratePaymentIntentInput {
  rideId: string;
  amount?: number; // Reais — opcional. Se ausente, usa priceOffered ou priceEstimated do RideRequest.
}

export class GeneratePaymentIntentUseCase {
  async execute(input: GeneratePaymentIntentInput): Promise<{ id: string; brCode: string; qrCodeUrl: string }> {
    const { rideId, amount } = input;

    const ride = await prisma.rideRequest.findUnique({
      where: { id: rideId },
      select: { id: true, priceOffered: true, priceEstimated: true },
    });

    if (!ride) {
      throw new Error(`Ride ${rideId} not found`);
    }

    const amountReais = amount ?? (ride.priceOffered ?? ride.priceEstimated ?? 0);

    if (!amountReais || amountReais <= 0) {
      throw new Error(`Invalid amount for ride ${rideId}: ${amountReais}`);
    }

    const amountCents = Math.round(amountReais * 100);

    const intent = await createPaymentIntent({
      rideRequestId: rideId,
      amountCents,
      provider: getPixProvider(),
      bus: getEventBus(),
    });

    return {
      id: intent.id,
      brCode: intent.qrCode ?? "",
      qrCodeUrl: intent.qrCodeImage ?? "",
    };
  }
}
