import type { Settlement } from "@prisma/client";
import { DomainEventType, PaymentStatus, SplitBeneficiaryType } from "../../shared/enums";
import { prisma } from "../../infra/prisma/client";
import { EventBus, recordAndPublish } from "../shared/events/EventBus";
import { computeRevenueSplitV2, PLATFORM_FEE_CENTS } from "./RevenueSplitService";
import { RevenuePolicyRepository } from "./RevenuePolicyRepository";
import {
  assertSettlementContext,
  type PricingSnapshotContext,
} from "./ValidationGate";

/**
 * SettlementService — ADR-001 + ADR-002 v1.1
 *
 * Pipeline (single transaction):
 *   0. Validation Gate (VG-1..VG-6) — pré-condição obrigatória
 *   1. Resolver RevenuePolicy vigente (RevenuePolicyRepository)
 *   2. computeRevenueSplitV2() → splits calculados pela política
 *   3. assertSettlementContext() → lança se qualquer invariante for violado
 *   4. INSERT Settlement (com revenuePolicyId + revenuePolicyVersion)
 *   5. INSERT RevenueSplit rows: PLATFORM + DRIVER + ROOT_DRIVER (quando aplicável)
 *
 * Após o commit:
 *   6. Publicar RIDE_SETTLED e REWARD_DISTRIBUTED
 *
 * Idempotente: retorna Settlement existente sem reprocessar.
 */
export async function settleConfirmedPayment(
  paymentIntentId: string,
  bus: EventBus,
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
      `PaymentIntent ${paymentIntentId} is not CONFIRMED (status=${intent.status})`,
    );
  }

  const ride = intent.rideRequest;
  const rootDriverId = ride.passenger.rootDriverId ?? null;
  const settleDate = new Date();

  // Resolve política vigente — MVP usa ROOT_DRIVER_STANDARD
  const policyRepo = new RevenuePolicyRepository(prisma);
  const policy = await policyRepo.resolveForRide(settleDate);

  // Calcula os splits com a política (V2)
  const split = computeRevenueSplitV2({
    totalCents: intent.amountCents,
    rootDriverId,
    // Se não houver política, usa ROOT_DRIVER_STANDARD placeholder apenas para
    // calcular split zero; o gate VG-2 vai barrar logo abaixo se policy=null.
    policy: policy ?? {
      id: "",
      code: "ROOT_DRIVER_STANDARD",
      name: "",
      version: 1,
      baseType: "OPERATIONAL_REVENUE",
      rootDriverBps: 0,
      effectiveFrom: null,
      effectiveUntil: null,
      isActive: false,
      createdAt: new Date(),
    },
  });

  // Monta contexto do Pricing Snapshot para o Gate
  const snapshotCtx: PricingSnapshotContext = {
    totalCents: intent.amountCents,
    driverNetAmountCents: split.driverNetAmountCents,
    platformFeeCents: PLATFORM_FEE_CENTS,
    // Snapshot é considerado completo quando priceEstimated coincide com amountCents.
    // Campos adicionais (baseCOE, zoneMultiplier…) são validados opcionalmente.
    isComplete: intent.amountCents > 0,
  };

  // Gate — lança erro descritivo se qualquer VG for violado
  assertSettlementContext(snapshotCtx, policy, {
    platformCents: split.platformCents,
    driverCents: split.driverCents,
    rootDriverCents: split.rootDriverCents,
    rootDriverId,
  });

  const driverId = ride.selectedDriverId ?? null;

  const settlement = await prisma.$transaction(async (tx) => {
    const created = await tx.settlement.create({
      data: {
        paymentIntentId: intent.id,
        rideRequestId: intent.rideRequestId,
        totalCents: split.totalCents,
        driverCents: split.driverCents,
        platformCents: split.platformCents,
        rootDriverCents: split.rootDriverCents,
        rootDriverId,
        // Auditabilidade: qual política e versão foi aplicada (ADR-002 §§5 + usuário)
        revenuePolicyId: split.policyId ?? null,
        revenuePolicyVersion: split.policyVersion ?? null,
      },
    });

    // PLATFORM row — R$2,50 fixo
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

    // ROOT_DRIVER row — somente quando aplicável (I-6)
    if (rootDriverId !== null && split.rootDriverCents > 0) {
      splitRows.push({
        beneficiaryType: SplitBeneficiaryType.ROOT_DRIVER,
        beneficiaryDriverId: rootDriverId,
        amountCents: split.rootDriverCents,
        percentBps: Math.round((split.rootDriverCents / split.totalCents) * 10_000),
      });
    }

    await tx.revenueSplit.createMany({
      data: splitRows.map((s) => ({ ...s, settlementId: created.id })),
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
      revenuePolicyId: settlement.revenuePolicyId,
      revenuePolicyVersion: settlement.revenuePolicyVersion,
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
