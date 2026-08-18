import type { PaymentIntent } from "@prisma/client";
import {
  DomainEventType,
  PaymentStatus,
  isValidPaymentTransition,
} from "../../shared/enums";
import { prisma } from "../../infra/prisma/client";
import {
  EventBus,
  recordAndPublish,
} from "../shared/events/EventBus";
import { PixProvider } from "./providers/PixProvider";
import { settleConfirmedPayment } from "./SettlementService";
import { startTripExecution } from "../trip/TripLifecycleService";

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
  if (existing) {
    // If the cached QR code is a stale PicPay dynamic URL, regenerate it in-place.
    const isStale = !existing.qrCode || existing.qrCode.includes("qr-code.picpay.com");
    if (!isStale) return existing;

    console.warn("[PaymentIntentService] QR code obsoleto detectado — regenerando via StaticPixProvider", {
      intentId: existing.id,
      rideRequestId,
    });
    const charge = await provider.createCharge({
      intentId: existing.id,
      amountCents: existing.amountCents,
    });
    return await prisma.paymentIntent.update({
      where: { id: existing.id },
      data: {
        externalId: charge.externalId,
        qrCode: charge.qrCode,
        qrCodeImage: charge.qrCodeImage,
      },
    });
  }

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
  // Coordination seam used to prove read/update interleavings against real PostgreSQL.
  afterIntentRead?: (intent: PaymentIntent) => Promise<void>;
}

/**
 * Idempotent webhook handler keyed by externalId.
 *
 *  - CONFIRMED → updates intent (if not already CONFIRMED), fires
 *    PAYMENT_CONFIRMED, then triggers SettlementService synchronously which
 *    emits RIDE_SETTLED + REWARD_DISTRIBUTED; the ride lifecycle stays unchanged.
 *  - FAILED    → updates intent, fires PAYMENT_FAILED. No settlement.
 */
export async function handlePixWebhook(
  input: HandlePixWebhookInput
): Promise<PaymentIntent> {
  const { externalId, status, failureReason, bus, afterIntentRead } = input;

  const intent = await prisma.paymentIntent.findUnique({
    where: { externalId },
  });
  if (!intent) {
    throw new Error(`PaymentIntent with externalId=${externalId} not found`);
  }
  await afterIntentRead?.(intent);

  if (status === "CONFIRMED") {
    if (
      intent.status !== PaymentStatus.CONFIRMED
      && !isValidPaymentTransition(intent.status, PaymentStatus.CONFIRMED)
    ) {
      return intent;
    }

    let confirmed = intent;
    if (intent.status !== PaymentStatus.CONFIRMED) {
      // CAS: exactly one caller owns the PENDING -> CONFIRMED transition/event.
      const transition = await prisma.paymentIntent.updateMany({
        where: { id: intent.id, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.CONFIRMED, confirmedAt: new Date() },
      });
      if (transition.count === 1) {
        confirmed = await prisma.paymentIntent.findUniqueOrThrow({
          where: { id: intent.id },
        });
        await recordAndPublish(bus, {
          type: DomainEventType.PAYMENT_CONFIRMED,
          aggregateType: "PaymentIntent",
          aggregateId: intent.id,
          payload: { externalId, amountCents: intent.amountCents },
        });
      } else {
        confirmed = await prisma.paymentIntent.findUniqueOrThrow({
          where: { id: intent.id },
        });
        if (confirmed.status !== PaymentStatus.CONFIRMED) return confirmed;
      }
    }
    await settleConfirmedPayment(intent.id, bus);
    await startTripExecution(intent.id, bus);
    return confirmed;
  }

  // FAILED
  if (!isValidPaymentTransition(intent.status, PaymentStatus.FAILED)) return intent;
  // The same CAS prevents a late FAILED webhook from overwriting a concurrent winner.
  const transition = await prisma.paymentIntent.updateMany({
    where: { id: intent.id, status: PaymentStatus.PENDING },
    data: {
      status: PaymentStatus.FAILED,
      failedAt: new Date(),
      failureReason: failureReason ?? null,
    },
  });
  if (transition.count === 0) {
    return prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
  }
  const failed = await prisma.paymentIntent.findUniqueOrThrow({
    where: { id: intent.id },
  });
  await recordAndPublish(bus, {
    type: DomainEventType.PAYMENT_FAILED,
    aggregateType: "PaymentIntent",
    aggregateId: intent.id,
    payload: { externalId, failureReason: failureReason ?? null },
  });
  return failed;
}
