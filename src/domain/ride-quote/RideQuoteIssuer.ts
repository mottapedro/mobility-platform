// RideQuoteIssuer — composição da precificação de oferta (Fase E).
//
// Bifase (contrato Fase E revisado):
//   1. POST /rides → RideQuote QUOTED (preço congelado, MUTÁVEL ainda). Nenhuma
//      oferta é emitida e nenhum dispatch é iniciado neste momento.
//   2. Confirmação do passageiro → QUOTED → AGREED (CAS) e só então a primeira
//      oferta é criada (EnsureFirstOfferService).
//
// Decisões de composição:
//   - M1 = passenger.referredByDriverId (SOMENTE). rootDriverId é ownership
//     econômico (participa do split V2) e NUNCA substitui o Motorista Dono.
//   - M   = DriverOriginResolver por modo: IMMEDIATE usa CURRENT_LOCATION fresca
//     primeiro e REGISTERED_BASE como fallback; SCHEDULED usa somente
//     REGISTERED_BASE.
//   - legCostMtoACents = M→A km × MTO_A_COST_CENTS_PER_KM (R$1,20/km)
//   - legPriceAtoBCents = totalPassengerPrice(A→B) × 100  (ADR-001 §3)
//   - grossFinalCents  = legCostMtoACents + legPriceAtoBCents
//   - driverReceivableAmountCents = split V2 (gross − PLATFORM_FEE_CENTS, com a
//     fatia do root deduzida segundo a RevenuePolicy congelada). Sem política
//     vigente, mantém o comportamento V1 (gross − PLATFORM_FEE_CENTS).
//
// Skip consciente (não lança por decisão de composição): o chamador decide o
// que fazer com o motivo (POST rejeita 422 quando M1 existe e a origem não
// resolve; o fluxo clássico só é usado para corridas SEM M1).

import { prisma } from "../../infra/prisma/client";
import { PricingService } from "../pricing/services/PricingService";
import {
  DriverOriginResolver,
  ResolvedOrigin,
  RideMode,
} from "../pricing/DriverOriginResolver";
import { RideQuoteService } from "./RideQuoteService";
import { RevenuePolicyRepository } from "../payment/RevenuePolicyRepository";
import {
  computeRevenueSplitV2,
  PLATFORM_FEE_CENTS,
} from "../payment/RevenueSplitService";

const MTO_A_COST_CENTS_PER_KM = 120; // R$1,20/km — decisão aprovada (Fase E)

const quoteService = new RideQuoteService();
const pricingService = new PricingService();
const policyRepo = new RevenuePolicyRepository(prisma);

export type QuoteIssueResult =
  | {
      issued: true;
      quoteId: string;
      grossFinalCents: number;
      driverReceivableAmountCents: number;
      legCostMtoACents: number;
      legPriceAtoBCents: number;
    }
  | {
      issued: false;
      reason:
        | "M1_NOT_RESOLVED"
        | "ORIGIN_UNRESOLVED"
        | "PRICING_UNAVAILABLE";
    };

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function toCents(reais: number): number {
  return Math.round(round(reais) * 100);
}

export interface IssueForRideOptions {
  mode: RideMode;
  /** Origem M já resolvida pelo chamador (evita dupla resolução no POST). */
  preResolvedOrigin?: ResolvedOrigin;
  /** Perna A→B já precificada em reais pelo chamador (evita re-precificar). */
  priceAtoBReais?: number;
}

export class RideQuoteIssuer {
  /**
   * Emite a quote da corrida em QUOTED (bifase). Idempotente por
   * (ride, M1): a partial unique index respalda a unicidade da quote viva.
   * Nunca lança exceção por decisão de composição — retorna o motivo de skip.
   */
  async issueForRide(
    rideId: string,
    options?: IssueForRideOptions,
  ): Promise<QuoteIssueResult> {
    const ride = await prisma.rideRequest.findUnique({
      where: { id: rideId },
      include: {
        passenger: {
          select: { rootDriverId: true, referredByDriverId: true },
        },
      },
    });

    if (!ride) {
      throw new Error(`Ride ${rideId} not found`);
    }

    const mode = options?.mode ?? (ride.scheduledAt ? "SCHEDULED" : "IMMEDIATE");

    // Decisão M1 — SOMENTE o motorista que indicou o passageiro é o M1.
    // rootDriverId é ownership econômico (split V2), não M1.
    const pricingDriverId = ride.passenger?.referredByDriverId ?? null;

    if (!pricingDriverId) {
      return { issued: false, reason: "M1_NOT_RESOLVED" };
    }

    // Campos de rota obrigatórios — corridas sem geocódigo não são precificáveis.
    const rideOriginLat = ride.originLat;
    const rideOriginLng = ride.originLng;
    const rideDistanceKm = ride.distanceKm;
    const rideDurationMin = ride.durationMin;

    if (
      rideOriginLat === null ||
      rideOriginLng === null ||
      rideDistanceKm === null ||
      rideDurationMin === null
    ) {
      return { issued: false, reason: "PRICING_UNAVAILABLE" };
    }

    // Origem M do motorista por modo (pre-resolvida pelo POST ou aqui).
    let origin = options?.preResolvedOrigin ?? null;
    if (!origin) {
      origin = await new DriverOriginResolver().resolveOriginForDriver({
        driverId: pricingDriverId,
        rideLat: rideOriginLat,
        rideLng: rideOriginLng,
        mode,
      });
    }

    if (!origin.resolved) {
      return { issued: false, reason: "ORIGIN_UNRESOLVED" };
    }

    // Levantamento da perna A→B (ADR-001). Preço pode vir do chamador
    // (POST já precificou) para garantir determinismo na mesma requisição.
    let priceAtoB: number;
    if (options?.priceAtoBReais !== undefined) {
      priceAtoB = options.priceAtoBReais;
    } else {
      try {
        const pricing = await pricingService.estimate({
          distanceKm: rideDistanceKm,
          estimatedDurationMin: rideDurationMin,
          originAddress: ride.origin,
          destinationAddress: ride.destination,
        });
        priceAtoB = pricing.totalPassengerPrice;
      } catch (error) {
        console.warn(
          `[RideQuoteIssuer] PricingEngine indisponível para ${rideId}:`,
          error instanceof Error ? error.message : error,
        );
        return { issued: false, reason: "PRICING_UNAVAILABLE" };
      }
    }

    const legCostMtoACents = Math.round(origin.distanceMtoAKm * MTO_A_COST_CENTS_PER_KM);
    const legPriceAtoBCents = toCents(priceAtoB);
    const grossFinalCents = legCostMtoACents + legPriceAtoBCents;

    // Snapshot da política vigente (reuso do Settlement) e recebível V2.
    // O root econômico participa do split; o driver recebe
    // gross − PLATFORM_FEE_CENTS − fatia do root.
    const policy = await policyRepo.resolveForRide(ride.scheduledAt ?? new Date());
    const economicRootDriverId =
      ride.rootDriverId ?? ride.passenger?.rootDriverId ?? null;

    let driverReceivableAmountCents: number;
    let revenuePolicyId: string | null = null;
    let revenuePolicyVersion: number | null = null;

    if (policy) {
      const split = computeRevenueSplitV2({
        totalCents: grossFinalCents,
        rootDriverId: economicRootDriverId,
        policy,
      });
      driverReceivableAmountCents = split.driverCents;
      revenuePolicyId = policy.id;
      revenuePolicyVersion = policy.version;
    } else {
      // Sem política vigente → comportamento V1 (taxa fixa, sem fatia de root).
      driverReceivableAmountCents = grossFinalCents - PLATFORM_FEE_CENTS;
    }

    const quote = await quoteService.issueQuote({
      rideRequestId: rideId,
      pricingDriverId,
      originMLat: origin.lat,
      originMLng: origin.lng,
      originMSource: origin.source,
      distanceMtoAKm: origin.distanceMtoAKm,
      distanceAtoBKm: rideDistanceKm,
      legCostMtoACents,
      legPriceAtoBCents,
      grossFinalCents,
      revenuePolicyId,
      revenuePolicyVersion,
      driverReceivableAmountCents,
    });

    // Bifase: a quote permanece QUOTED — a confirmação (AGREED) e a primeira
    // oferta ocorrem quando o passageiro confirma o preço.
    // Mantém priceEstimated em reais como espelho do gross da quote.
    await prisma.rideRequest.update({
      where: { id: rideId },
      data: { priceEstimated: grossFinalCents / 100 },
    });

    return {
      issued: true,
      quoteId: quote.id,
      grossFinalCents,
      driverReceivableAmountCents,
      legCostMtoACents,
      legPriceAtoBCents,
    };
  }
}
