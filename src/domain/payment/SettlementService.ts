import {
  DomainEventType,
  PaymentStatus,
  RideStatus,
  Settlement,
  SplitBeneficiaryType,
} from "@prisma/client";
import { prisma } from "../../infra/prisma/client";
import {
  EventBus,
  recordAndPublish,
} from "../shared/events/EventBus";
import { computeRevenueSplit, SPLIT_BPS } from "./RevenueSplitService";

/**
 * SettlementService — synchronous, idempotent settlement of a confirmed
 * PaymentIntent.
 *
 * Pipeline (single transaction):
 *   1. Re-load PaymentIntent (must be CONFIRMED)
 *   2. Resolve rootDriverId via RideRequest.passenger.rootDriverId
 *   3. computeRevenueSplit() → driver / platform / root cents
 *   4. Insert Settlement + 3 RevenueSplit rows
 *   5. Transition RideRequest.status → PAID
 *
 * After commit (outside the tx):
 *   6. Persist + publish RIDE_SETTLED and REWARD_DISTRIBUTED domain events.
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
        rootDriverId: split.rootDriverId,
      },
    });

    const splitRows: Array<{
      beneficiaryType: SplitBeneficiaryType;
      beneficiaryDriverId: string | null;
      amountCents: number;
      percentBps: number;
    }> = [
      {
        beneficiaryType: SplitBeneficiaryType.DRIVER,
        beneficiaryDriverId: driverId,
        amountCents: split.driverCents,
        percentBps: SPLIT_BPS.DRIVER,
      },
      {
        beneficiaryType: SplitBeneficiaryType.PLATFORM,
        beneficiaryDriverId: null,
        amountCents: split.platformCents,
        percentBps:
          split.rootDriverId === null
            ? SPLIT_BPS.PLATFORM + SPLIT_BPS.ROOT_DRIVER
            : SPLIT_BPS.PLATFORM,
      },
      {
        beneficiaryType: SplitBeneficiaryType.ROOT_DRIVER,
        beneficiaryDriverId: split.rootDriverId,
        amountCents: split.rootDriverCents,
        percentBps: split.rootDriverId === null ? 0 : SPLIT_BPS.ROOT_DRIVER,
      },
    ];

    await tx.revenueSplit.createMany({
      data: splitRows.map((s) => ({ ...s, settlementId: created.id })),
    });

    await tx.rideRequest.update({
      where: { id: intent.rideRequestId },
      data: { status: RideStatus.PAID },
    });

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
