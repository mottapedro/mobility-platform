/**
 * Application Service: ConfirmPixSettlementService
 *
 * Stage 2.B service. Stable application-layer entry for the
 * "PIX webhook reports CONFIRMED -> settle the ride" flow.
 *
 * Thin wrapper around `handlePixWebhook(..., "CONFIRMED")` from
 * PaymentIntentService, which itself triggers `settleConfirmedPayment`
 * (SettlementService) synchronously. Both downstream operations are
 * already idempotent (keyed by externalId and paymentIntentId respectively),
 * so this wrapper inherits idempotency.
 *
 * The wrapper narrows the public API to the CONFIRMED-only path (FAILED
 * webhooks have their own conceptually distinct flow and stay on the raw
 * `handlePixWebhook` API). It also surfaces the resulting Settlement row
 * alongside the confirmed PaymentIntent and reports whether the settlement
 * was created in THIS call (`settled: true`) or already existed
 * (`settled: false`, idempotent replay).
 *
 * Event chain (delegated):
 *   - PAYMENT_CONFIRMED  (first time only)
 *   - RIDE_SETTLED       (first time only)
 *   - REWARD_DISTRIBUTED (first time only)
 *   - RideRequest.status remains unchanged (Model B)
 */

import type { PaymentIntent, Settlement } from "@prisma/client";
import { prisma } from "../../infra/prisma/client";
import { handlePixWebhook } from "../../domain/payment/PaymentIntentService";
import { EventBus } from "../../domain/shared/events/EventBus";

export interface ConfirmPixSettlementInput {
  externalId: string;
  confirmationSource?: "PIX_WEBHOOK" | "MANUAL";
}

export interface ConfirmPixSettlementResult {
  intent: PaymentIntent;
  settlement: Settlement;
  settled: boolean;
}

export interface ConfirmPixSettlementDeps {
  bus: EventBus;
}

export async function execute(
  input: ConfirmPixSettlementInput,
  deps: ConfirmPixSettlementDeps
): Promise<ConfirmPixSettlementResult> {
  // Probe for a pre-existing settlement so we can report `settled` accurately
  // on idempotent replays. We look up the intent first to get its id.
  const preIntent = await prisma.paymentIntent.findUnique({
    where: { externalId: input.externalId },
  });
  if (!preIntent) {
    throw new Error(
      `ConfirmPixSettlement: PaymentIntent with externalId=${input.externalId} not found`
    );
  }
  const preExisting = await prisma.settlement.findUnique({
    where: { paymentIntentId: preIntent.id },
  });

  const intent = await handlePixWebhook({
    externalId: input.externalId,
    status: "CONFIRMED",
    confirmationSource: input.confirmationSource,
    bus: deps.bus,
  });

  const settlement = await prisma.settlement.findUnique({
    where: { paymentIntentId: intent.id },
  });
  if (!settlement) {
    // settleConfirmedPayment guarantees a Settlement row on the CONFIRMED
    // path; missing row would mean a downstream contract break.
    throw new Error(
      `ConfirmPixSettlement: settlement missing for intent ${intent.id} after CONFIRMED webhook`
    );
  }

  return {
    intent,
    settlement,
    settled: preExisting === null,
  };
}

export const ConfirmPixSettlementService = { execute };
