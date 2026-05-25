import {
  DomainEventType,
  PaymentIntent,
  PaymentStatus,
} from "@prisma/client";
import { prisma } from "../../infra/prisma/client";
import {
  EventBus,
  recordAndPublish,
} from "../shared/events/EventBus";
import { PixProvider } from "./providers/PixProvider";
import { settleConfirmedPayment } from "./SettlementService";

export interface CreatePaymentIntentInput {
  rideRequestId: string;
  amountCents: number;
  provider: PixProvider;
  bus: EventBus;
}

/**
 * Creates a PaymentIntent for a ride, requests a Pix QR code from the provider,
 * and emits the lifecycle events. Idempotent on rideRequestId.
 */
export async function createPaymentIntent(
  input: CreatePaymentIntentInput
): Promise<PaymentIntent> {
  const { rideRequestId, amountCents, provider, bus } = input;

  const existing = await prisma.paymentIntent.findUnique({
    where: { rideRequestId },
  });
  if (existing) return existing;

  const ride = await prisma.rideRequest.findUnique({
    where: { id: rideRequestId },
    select: { id: true },
  });
  if (!ride) {
    throw new Error(`RideRequest ${rideRequestId} not found`);
  }
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error(`amountCents must be a positive integer, got ${amountCents}`);
  }

  const intent = await prisma.paymentIntent.create({
    data: { rideRequestId, amountCents },
  });

  await recordAndPublish(bus, {
    type: DomainEventType.PAYMENT_INTENT_CREATED,
    aggregateType: "PaymentIntent",
    aggregateId: intent.id,
    payload: { rideRequestId, amountCents },
  });

  const charge = await provider.createCharge({
    intentId: intent.id,
    amountCents,
  });

  const updated = await prisma.paymentIntent.update({
    where: { id: intent.id },
    data: {
      externalId: charge.externalId,
      qrCode: charge.qrCode,
      qrCodeImage: charge.qrCodeImage,
    },
  });

  await recordAndPublish(bus, {
    type: DomainEventType.PIX_QRCODE_GENERATED,
    aggregateType: "PaymentIntent",
    aggregateId: intent.id,
    payload: { externalId: charge.externalId },
  });

  return updated;
}

export type WebhookStatus = "CONFIRMED" | "FAILED";

export interface HandlePixWebhookInput {
  externalId: string;
  status: WebhookStatus;
  failureReason?: string;
  bus: EventBus;
}

/**
 * Idempotent webhook handler keyed by externalId.
 *
 *  - CONFIRMED → updates intent (if not already CONFIRMED), fires
 *    PAYMENT_CONFIRMED, then triggers SettlementService synchronously which
 *    emits RIDE_SETTLED + REWARD_DISTRIBUTED and transitions the ride to PAID.
 *  - FAILED    → updates intent, fires PAYMENT_FAILED. No settlement.
 */
export async function handlePixWebhook(
  input: HandlePixWebhookInput
): Promise<PaymentIntent> {
  const { externalId, status, failureReason, bus } = input;

  const intent = await prisma.paymentIntent.findUnique({
    where: { externalId },
  });
  if (!intent) {
    throw new Error(`PaymentIntent with externalId=${externalId} not found`);
  }

  if (status === "CONFIRMED") {
    let confirmed = intent;
    if (intent.status !== PaymentStatus.CONFIRMED) {
      confirmed = await prisma.paymentIntent.update({
        where: { id: intent.id },
        data: { status: PaymentStatus.CONFIRMED, confirmedAt: new Date() },
      });
      await recordAndPublish(bus, {
        type: DomainEventType.PAYMENT_CONFIRMED,
        aggregateType: "PaymentIntent",
        aggregateId: intent.id,
        payload: { externalId, amountCents: intent.amountCents },
      });
    }
    await settleConfirmedPayment(intent.id, bus);
    return confirmed;
  }

  // FAILED
  if (intent.status === PaymentStatus.FAILED) return intent;
  const failed = await prisma.paymentIntent.update({
    where: { id: intent.id },
    data: {
      status: PaymentStatus.FAILED,
      failedAt: new Date(),
      failureReason: failureReason ?? null,
    },
  });
  await recordAndPublish(bus, {
    type: DomainEventType.PAYMENT_FAILED,
    aggregateType: "PaymentIntent",
    aggregateId: intent.id,
    payload: { externalId, failureReason: failureReason ?? null },
  });
  return failed;
}
