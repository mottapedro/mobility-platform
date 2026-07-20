import type { Settlement } from "@prisma/client";
import { DomainEventType, PaymentStatus, RideStatus, SplitBeneficiaryType } from "../../shared/enums";
import { prisma } from "../../infra/prisma/client";
import {
  EventBus,
  recordAndPublish,
} from "../shared/events/EventBus";
import { computeRevenueSplit, PLATFORM_FEE_CENTS } from "./RevenueSplitService";

/**
 * SettlementService — synchronous, idempotent settlement of a confirmed
 * PaymentIntent.
 *
 * ADR-001 §4: Settlement liquidates pre-persisted Pricing Snapshot values.
 * It does NOT recalculate prices or apply percentage splits.
 *
 * Pipeline (single transaction):
 *   1. Re-load PaymentIntent (must be CONFIRMED)
 *   2. Resolve rootDriverId via RideRequest.passenger.rootDriverId
 *   3. computeRevenueSplit() → platformCents=R$2,50 fixed / driverCents=remainder
 *   4. Insert Settlement + 2 RevenueSplit rows (PLATFORM + DRIVER)
 *
 * After commit (outside the tx):
 *   5. Persist + publish RIDE_SETTLED and REWARD_DISTRIBUTED domain events.
 *
 * Idempotency: if a Settlement already exists for this PaymentIntent, returns
 * it untouched and skips the events.
 */
export async function settleConfirmedPayment(
  paymentIntentId: string,
  bus: EventBus
): Promise<Settlement> {
  const existing = await prisma.settlement.findUnique({
    where: { paymentIntentId },
  });
  if (existing) return existing;

  const intent = await prisma.paymentIntent.findUnique({
    where: { id: paymentIntentId },
    include: {
      rideRequest: { include: { passenger: true } },
    },
  });
  if (!intent) {
    throw new Error(`PaymentIntent ${paymentIntentId} not found`);
  }
  if (intent.status !== PaymentStatus.CONFIRMED) {
    throw new Error(
      `PaymentIntent ${paymentIntentId} is not CONFIRMED (status=${intent.status})`
    );
  }

  const rootDriverId = intent.rideRequest.passenger.rootDriverId ?? null;
  const split = computeRevenueSplit({
    totalCents: intent.amountCents,
    rootDriverId,
  });

  const driverId = intent.rideRequest.selectedDriverId ?? null;

  const settlement = await prisma.$transaction(async (tx) => {
    const created = await tx.settlement.create({
      data: {
        paymentIntentId: intent.id,
        rideRequestId: intent.rideRequestId,
        totalCents: split.totalCents,
        driverCents: split.driverCents,
        platformCents: split.platformCents,
        rootDriverCents: split.rootDriverCents,
        rootDriverId: rootDriverId,
      },
    });

    // ADR-001 §4: 2 rows — PLATFORM (R$2,50 fixed) + DRIVER (remainder).
    // ROOT_DRIVER row reserved for RevenueSplit V2 (ADR-001 §8 step 7).
    const splitRows: Array<{
      beneficiaryType: SplitBeneficiaryType;
      beneficiaryDriverId: string | null;
      amountCents: number;
      percentBps: number;
    }> = [
      {
        beneficiaryType: SplitBeneficiaryType.PLATFORM,
        beneficiaryDriverId: null,
        amountCents: split.platformCents,
        percentBps: Math.round((split.platformCents / split.totalCents) * 10_000),
      },
      {
        beneficiaryType: SplitBeneficiaryType.DRIVER,
        beneficiaryDriverId: driverId,
        amountCents: split.driverCents,
        percentBps: Math.round((split.driverCents / split.totalCents) * 10_000),
      },
    ];

    await tx.revenueSplit.createMany({
      data: splitRows.map((s) => ({ ...s, settlementId: created.id })),
    });

    // In Model B, payment is tracked separately and does not transition ride status.
    // The ride remains COMPLETED after settlement. Payment status lives in PaymentIntent.

    return created;
  });

  await recordAndPublish(bus, {
    type: DomainEventType.RIDE_SETTLED,
    aggregateType: "Settlement",
    aggregateId: settlement.id,
    payload: {
      paymentIntentId: intent.id,
      rideRequestId: intent.rideRequestId,
      totalCents: settlement.totalCents,
      driverCents: settlement.driverCents,
      platformCents: settlement.platformCents,
      rootDriverCents: settlement.rootDriverCents,
      rootDriverId: settlement.rootDriverId,
    },
  });

  await recordAndPublish(bus, {
    type: DomainEventType.REWARD_DISTRIBUTED,
    aggregateType: "Settlement",
    aggregateId: settlement.id,
    payload: {
      driverId,
      driverCents: settlement.driverCents,
      rootDriverId: settlement.rootDriverId,
      rootDriverCents: settlement.rootDriverCents,
    },
  });

  return settlement;
}
