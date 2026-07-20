/**
 * Application Service: RewardDistributionService
 *
 * Stage 2.B.9 — Discrete distribution of earned rewards for a settled ride.
 *
 * Responsibility: given an existing Settlement, create the three RevenueSplit
 * rows (DRIVER / PLATFORM / ROOT_DRIVER) and emit the REWARD_DISTRIBUTED
 * domain event exactly once.
 *
 * Idempotency: keyed on the presence of RevenueSplit rows for the settlement.
 * If rows already exist (e.g. created inline by SettlementService), the call
 * is a no-op and returns { distributed: false }.
 *
 * Design intent: SettlementService continues to own the full settlement
 * pipeline (no changes). RewardDistributionService exists as a standalone
 * application-layer call for:
 *   - PixPaymentOrchestrator composition (2.B.10)
 *   - Retroactive / promotional reward scenarios
 *   - Direct composition without re-running settlement
 */

import { DomainEventType, SplitBeneficiaryType } from "../../shared/enums";
import { prisma } from "../../infra/prisma/client";
import { EventBus, recordAndPublish } from "../../domain/shared/events/EventBus";
import { PLATFORM_FEE_CENTS } from "../../domain/payment/RevenueSplitService";

type Db = Pick<
  typeof prisma,
  "settlement" | "revenueSplit" | "rideRequest" | "domainEvent"
>;

export interface RewardDistributionInput {
  settlementId: string;
}

export interface RewardDistributionResult {
  driverCents: number;
  platformCents: number;
  rootDriverCents: number;
  rootDriverId: string | null;
  distributed: boolean;
}

export interface RewardDistributionDeps {
  db?: Db;
  bus?: EventBus;
}

export async function execute(
  input: RewardDistributionInput,
  deps: RewardDistributionDeps = {}
): Promise<RewardDistributionResult> {
  const db = deps.db ?? prisma;
  const bus = deps.bus;

  const settlement = await db.settlement.findUnique({
    where: { id: input.settlementId },
    include: { splits: true },
  });
  if (!settlement) {
    throw new Error(
      `RewardDistribution: Settlement not found: ${input.settlementId}`
    );
  }

  // Idempotency — splits already exist (e.g. created by SettlementService inline).
  if (settlement.splits.length > 0) {
    return {
      driverCents: settlement.driverCents,
      platformCents: settlement.platformCents,
      rootDriverCents: settlement.rootDriverCents,
      rootDriverId: settlement.rootDriverId,
      distributed: false,
    };
  }

  const rideRequest = await db.rideRequest.findUnique({
    where: { id: settlement.rideRequestId },
    select: { selectedDriverId: true },
  });
  const driverId = rideRequest?.selectedDriverId ?? null;
  const rootDriverId = settlement.rootDriverId;

  // ADR-001 §4: 2 rows — PLATFORM (R$2,50 fixed) + DRIVER (remainder).
  // percentBps derived from actual cents ratio (not hardcoded BPS constants).
  // ROOT_DRIVER row reserved for RevenueSplit V2 (ADR-001 §8 step 7).
  void PLATFORM_FEE_CENTS; // referenced to satisfy import — used at computeRevenueSplit layer
  const total = settlement.totalCents;
  await db.revenueSplit.createMany({
    data: [
      {
        settlementId: settlement.id,
        beneficiaryType: SplitBeneficiaryType.PLATFORM,
        beneficiaryDriverId: null,
        amountCents: settlement.platformCents,
        percentBps: Math.round((settlement.platformCents / total) * 10_000),
      },
      {
        settlementId: settlement.id,
        beneficiaryType: SplitBeneficiaryType.DRIVER,
        beneficiaryDriverId: driverId,
        amountCents: settlement.driverCents,
        percentBps: Math.round((settlement.driverCents / total) * 10_000),
      },
    ],
  });

  if (bus) {
    await recordAndPublish(
      bus,
      {
        type: DomainEventType.REWARD_DISTRIBUTED,
        aggregateType: "Settlement",
        aggregateId: settlement.id,
        payload: {
          driverId,
          driverCents: settlement.driverCents,
          rootDriverId,
          rootDriverCents: settlement.rootDriverCents,
        },
      },
      db
    );
  }

  return {
    driverCents: settlement.driverCents,
    platformCents: settlement.platformCents,
    rootDriverCents: settlement.rootDriverCents,
    rootDriverId,
    distributed: true,
  };
}

export const RewardDistributionService = { execute };
