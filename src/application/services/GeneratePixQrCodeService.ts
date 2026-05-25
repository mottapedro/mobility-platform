/**
 * Application Service: GeneratePixQrCodeService
 *
 * Stage 2.B leaf service. Stable application-layer entry for the
 * "create PaymentIntent + ask PixProvider for a QR code" flow.
 *
 * Delegates to `createPaymentIntent` (domain) so the existing
 * PAYMENT_INTENT_CREATED + PIX_QRCODE_GENERATED event chain remains
 * authoritative. Idempotent on rideRequestId.
 */

import type { PaymentIntent } from "@prisma/client";
import { createPaymentIntent } from "../../domain/payment/PaymentIntentService";
import { PixProvider } from "../../domain/payment/providers/PixProvider";
import { EventBus } from "../../domain/shared/events/EventBus";

export interface GeneratePixQrCodeInput {
  rideRequestId: string;
  amountCents: number;
}

export interface GeneratePixQrCodeResult {
  intent: PaymentIntent;
  qrCode: string | null;
  qrCodeImage: string | null;
  externalId: string | null;
}

export interface GeneratePixQrCodeDeps {
  provider: PixProvider;
  bus: EventBus;
}

export async function execute(
  input: GeneratePixQrCodeInput,
  deps: GeneratePixQrCodeDeps
): Promise<GeneratePixQrCodeResult> {
  const intent = await createPaymentIntent({
    rideRequestId: input.rideRequestId,
    amountCents: input.amountCents,
    provider: deps.provider,
    bus: deps.bus,
  });

  return {
    intent,
    qrCode: intent.qrCode,
    qrCodeImage: intent.qrCodeImage,
    externalId: intent.externalId,
  };
}

export const GeneratePixQrCodeService = { execute };
