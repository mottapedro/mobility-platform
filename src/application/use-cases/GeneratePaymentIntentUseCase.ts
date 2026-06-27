import { prisma } from "../../infra/prisma/client";
import { PicPayGateway } from "../../modules/settlement/gateways/picpay/PicPayGateway";
import { PaymentIntentDTO } from "../../modules/settlement/gateways/picpay/dto/PaymentIntentDTO";

export interface GeneratePaymentIntentInput {
  rideId: string;
  amount?: number; // Reais — opcional. Se ausente, usa priceOffered ou priceEstimated do RideRequest.
}

export class GeneratePaymentIntentUseCase {
  private readonly gateway: PicPayGateway;

  constructor(gateway?: PicPayGateway) {
    this.gateway = gateway ?? new PicPayGateway();
  }

  async execute(input: GeneratePaymentIntentInput): Promise<{ id: string; brCode: string; qrCodeUrl: string }> {
    const { rideId, amount } = input;

    // 1. Buscar preço da corrida
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

    // Converter reais → centavos (evita floating point com round)
    const amountCents = Math.round(amountReais * 100);

    // 2. Chamar PicPay para criar intenção real
    const externalId = `ride-${rideId}-${Date.now()}`;
    const payload: PaymentIntentDTO = {
      amountCents,
      externalId,
      description: `Corrida ${rideId}`,
    };

    const picPayResponse = await this.gateway.createPaymentIntent(payload);

    const brCode = picPayResponse.brCode ?? "";
    const qrCodeUrl = picPayResponse.qrCodeUrl ?? "";

    // 3. Criar PaymentIntent
    const paymentIntent = await prisma.paymentIntent.create({
      data: {
        rideRequestId: rideId,
        amountCents,
        method: "PIX",
        status: "PENDING",
        qrCode: brCode,
        qrCodeImage: qrCodeUrl ? `${qrCodeUrl}/image.png` : undefined,
        externalId,
      },
    });

    return {
      id: paymentIntent.id,
      brCode,
      qrCodeUrl,
    };
  }
}
