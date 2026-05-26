/**
 * Application Service: PixPaymentOrchestrator
 *
 * Stage 2.B.10 — End-to-end PIX payment composition.
 *
 * Orchestrates the full payment lifecycle for a single ride in three
 * sequential steps:
 *   1. GeneratePixQrCodeService  → creates PaymentIntent + QR code
 *   2. ConfirmPixSettlementService → processes CONFIRMED webhook → Settlement
 *   3. RewardDistributionService  → distributes RevenueSplit rows (idempotent)
 *
 * Each delegate is individually idempotent. The orchestrator itself is
 * idempotent: calling it twice for the same rideRequestId returns the
 * existing intent/settlement and `settled: false, distributed: false` on
 * the second call.
 *
 * Design note: in the compose path `RewardDistributionService.distributed`
 * will be `false` because `SettlementService` (called inside step 2) already
 * created the RevenueSplit rows. The field is still surfaced so callers can
 * distinguish a freshly-orchestrated payment from an idempotent replay.
 */

import type { PaymentIntent, Settlement } from "@prisma/client";
import { execute as generateQr } from "./GeneratePixQrCodeService";
import { execute as confirmSettlement } from "./ConfirmPixSettlementService";
import { execute as distributeRewards } from "./RewardDistributionService";
import { PixProvider } from "../../domain/payment/providers/PixProvider";
import { EventBus } from "../../domain/shared/events/EventBus";

export interface PixPaymentOrchestratorInput {
  rideRequestId: string;
  amountCents: number;
}

export interface PixPaymentOrchestratorResult {
  intent: PaymentIntent;
  qrCode: string | null;
  qrCodeImage: string | null;
  settlement: Settlement;
  settled: boolean;
  driverCents: number;
  platformCents: number;
  rootDriverCents: number;
  rootDriverId: string | null;
  distributed: boolean;
}

export interface PixPaymentOrchestratorDeps {
  provider: PixProvider;
  bus: EventBus;
}

export async function execute(
  input: PixPaymentOrchestratorInput,
  deps: PixPaymentOrchestratorDeps
): Promise<PixPaymentOrchestratorResult> {
  // Step 1 — Generate QR code and create PaymentIntent
  const qrResult = await generateQr(
    { rideRequestId: input.rideRequestId, amountCents: input.amountCents },
    { provider: deps.provider, bus: deps.bus }
  );
  const { intent, qrCode, qrCodeImage } = qrResult;

  if (!intent.externalId) {
    throw new Error(
      `PixPaymentOrchestrator: PaymentIntent ${intent.id} has no externalId — provider did not assign one`
    );
  }

  // Step 2 — Confirm webhook → Settlement
  const confirmResult = await confirmSettlement(
    { externalId: intent.externalId },
    { bus: deps.bus }
  );
  const { settlement, settled } = confirmResult;

  // Step 3 — Distribute rewards (idempotent; splits usually already created by SettlementService)
  const rewardResult = await distributeRewards(
    { settlementId: settlement.id },
    { bus: deps.bus }
  );

  return {
    intent: confirmResult.intent,
    qrCode,
    qrCodeImage,
    settlement,
    settled,
    driverCents: rewardResult.driverCents,
    platformCents: rewardResult.platformCents,
    rootDriverCents: rewardResult.rootDriverCents,
    rootDriverId: rewardResult.rootDriverId,
    distributed: rewardResult.distributed,
  };
}

export const PixPaymentOrchestrator = { execute };
