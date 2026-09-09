import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../infra/prisma/client";
import { FEATURES } from "../../config/features";
import { MatchRideUseCase } from "../../application/use-cases/MatchRideUseCase";
import { PricingService } from "../../domain/pricing/services/PricingService";
import { HaversineRouteCalculator } from "../../domain/pricing/RouteCalculator";
import { AcceptancePolicyEngine } from "../../domain/services/AcceptancePolicyEngine";
import { logMatchingEvent } from "../../shared/logging/matchingLog";
import { matchingJobScheduler } from "../../infra/async/MatchingJobScheduler";
import { RescheduleRideUseCase } from "../../application/use-cases/RescheduleRideUseCase";
import { StartRideUseCase } from "../../application/use-cases/StartRideUseCase";
import { CompleteRideUseCase } from "../../application/use-cases/CompleteRideUseCase";
import type { RidePricing } from "../../domain/pricing/RidePricing";
import { resolveOwnershipV2 } from "../../domain/ownership/OwnershipResolver";
import { OwnershipPolicyRepository } from "../../domain/ownership/OwnershipPolicyRepository";
import {
  PlaceValidationService,
  OperationalBaseResult,
} from "../../domain/places/PlaceValidationService";
import { RideQuoteIssuer } from "../../domain/ride-quote/RideQuoteIssuer";
import { RideQuoteService } from "../../domain/ride-quote/RideQuoteService";
import { EnsureFirstOfferService } from "../../application/services/EnsureFirstOfferService";
import {
  DriverOriginResolver,
  ResolvedOrigin,
  RideMode,
} from "../../domain/pricing/DriverOriginResolver";
import { PUBLIC_USER_SELECT } from "../../shared/http/userPublic";
import type { AuthenticatedPassengerRequest } from "../middleware/requirePassengerBearerAuth";
import type { AuthenticatedRideReadRequest } from "../middleware/requireRideReadBearerAuth";

export interface RideContext {
  isVip?:     boolean;
  isAirport?: boolean;
  isPet?:     boolean;
  isLuggage?: boolean;
}

function normalizeContext(raw: unknown): RideContext {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw))
    ? raw as Record<string, unknown>
    : {};
  return {
    isVip:     Boolean(r.isVip),
    isAirport: Boolean(r.isAirport),
    isPet:     Boolean(r.isPet),
    isLuggage: Boolean(r.isLuggage),
  };
}

const routeCalc = new HaversineRouteCalculator();
const placeValidationService = new PlaceValidationService();

export class RideController {
  private readonly rideReadInclude = {
    passenger: { include: { user: { select: PUBLIC_USER_SELECT } } },
    offers: {
      include: {
        driver: { include: { user: { select: PUBLIC_USER_SELECT } } },
      },
    },
    selectedDriver: { include: { user: { select: PUBLIC_USER_SELECT } } },
  } as const;

  private toRidePayload<T extends { priceOffered: number | null; priceEstimated: number | null }>(
    ride: T,
  ) {
    return {
      ...ride,
      priceBrl: ride.priceOffered ?? ride.priceEstimated ?? null,
    };
  }

  async listMyRides(req: AuthenticatedPassengerRequest, res: Response) {
    const passengerId = req.authPassengerId;
    if (!passengerId) {
      return res.status(401).json({ error: "Passenger authentication required" });
    }

    try {
      const rides = await prisma.rideRequest.findMany({
        where: { passengerId },
        include: this.rideReadInclude,
        orderBy: { createdAt: "desc" },
      });

      return res.status(200).json(rides.map((ride) => this.toRidePayload(ride)));
    } catch (error) {
      console.error("Erro ao listar corridas do passageiro:", error);
      return res.status(500).json({
        error: "Erro interno ao listar corridas",
        details: error instanceof Error ? error.message : error,
      });
    }
  }

  async create(req: Request, res: Response) {
    console.log("🚨 VERSÃO MELHORADA DO CONTROLLER");
    console.log("🔥 BODY:", req.body);

    try {
      const {
        passengerId, origin, destination, scheduledAt,
        context: rawContext, candidateDriverIds,
        originLat: rawOriginLat, originLng: rawOriginLng,
        destinationLat: rawDestLat, destinationLng: rawDestLng,
      } = req.body;

      if (
        typeof rawOriginLat !== "number" || typeof rawOriginLng !== "number" ||
        typeof rawDestLat !== "number" || typeof rawDestLng !== "number"
      ) {
        return res.status(400).json({
          error: "Invalid coordinates",
          details: "originLat, originLng, destinationLat e destinationLng são obrigatórios e devem ser números.",
        });
      }

      if (!passengerId || !origin || !destination) {
        return res.status(400).json({
          error: "Missing fields",
          required: ["passengerId", "origin", "destination"],
          details: "scheduledAt é opcional: ausente/null = IMMEDIATE; data futura = SCHEDULED",
        });
      }

      if (
        typeof passengerId !== "string" ||
        typeof origin !== "string" ||
        typeof destination !== "string"
      ) {
        return res.status(400).json({
          error: "Invalid field types",
          details: "passengerId, origin e destination devem ser strings; scheduledAt opcional em ISO",
        });
      }

      if (scheduledAt !== undefined && scheduledAt !== null && typeof scheduledAt !== "string") {
        return res.status(400).json({
          error: "Invalid field types",
          details: "scheduledAt deve ser string ISO ou ausente/null (IMMEDIATE)",
        });
      }

      const originTrimmed = origin.trim();
      const destinationTrimmed = destination.trim();

      if (!originTrimmed || !destinationTrimmed) {
        return res.status(400).json({ error: "Origin and destination cannot be empty" });
      }

      if (originTrimmed.toLowerCase() === destinationTrimmed.toLowerCase()) {
        return res.status(400).json({ error: "Origin and destination must be different" });
      }

      // ─── Decision B — server-side validation of the operational base ──────
      // providerPlaceId (Google Place Details New) is the source of truth.
      // Client lat/lng is never trusted when a place id is supplied. When the
      // API key is absent (dev/tests), the service passes through client coords.
      const {
        originPlaceId: rawOriginPlaceId,
        destinationPlaceId: rawDestinationPlaceId,
      } = req.body as {
        originPlaceId?: unknown;
        destinationPlaceId?: unknown;
      };

      const originPlaceId =
        typeof rawOriginPlaceId === "string" && rawOriginPlaceId.trim()
          ? rawOriginPlaceId.trim()
          : null;
      const destinationPlaceId =
        typeof rawDestinationPlaceId === "string" && rawDestinationPlaceId.trim()
          ? rawDestinationPlaceId.trim()
          : null;

      const [originBase, destinationBase] = await Promise.all([
        placeValidationService.validateBase({
          providerPlaceId: originPlaceId,
          address: originTrimmed,
          lat: rawOriginLat,
          lng: rawOriginLng,
        }),
        placeValidationService.validateBase({
          providerPlaceId: destinationPlaceId,
          address: destinationTrimmed,
          lat: rawDestLat,
          lng: rawDestLng,
        }),
      ]);

      const invalidBase = [originBase, destinationBase].find(
        (base): base is Extract<OperationalBaseResult, { valid: false }> => !base.valid,
      );
      if (invalidBase) {
        return res.status(400).json({
          error: "Invalid operational base",
          code: invalidBase.code,
          details: invalidBase.reason,
          base: invalidBase.address,
        });
      }

      const authoritativeOrigin = originBase as Extract<OperationalBaseResult, { valid: true }>;
      const authoritativeDestination = destinationBase as Extract<OperationalBaseResult, { valid: true }>;

      const resolvedOriginLat = authoritativeOrigin.lat;
      const resolvedOriginLng = authoritativeOrigin.lng;
      const resolvedDestLat = authoritativeDestination.lat;
      const resolvedDestLng = authoritativeDestination.lng;

      // ─── RouteCalculator → distância e duração ─────────────────────────────
      const route = await routeCalc.calculate(
        { lat: resolvedOriginLat, lng: resolvedOriginLng },
        { lat: resolvedDestLat, lng: resolvedDestLng },
      );
      const { distanceKm, estimatedDurationMin } = route;

      // ─── PricingEngine → RidePricing ────────────────────────────────────────
      let ridePricing: RidePricing | null = null;

      if (FEATURES.PRICING_ENABLED) {
        try {
          const pricingService = new PricingService();
          ridePricing = await pricingService.estimate({
            distanceKm,
            estimatedDurationMin,
            originAddress: originTrimmed,
            destinationAddress: destinationTrimmed,
          });
          console.log("💰 PricingEngine resultado", {
            distanceKm,
            driverNetAmount: ridePricing.driverNetAmount,
            platformFee: ridePricing.platformFee,
            totalPassengerPrice: ridePricing.totalPassengerPrice,
            pricingVersion: ridePricing.pricingVersion,
          });
        } catch (pricingError) {
          console.warn("⚠️ PricingEngine fallback — usando fórmula simples:", pricingError);
        }
      }

      const priceEstimated = ridePricing
        ? ridePricing.totalPassengerPrice
        : Math.round((5.0 + 2.5 * distanceKm) * 100) / 100;

      const context = normalizeContext(rawContext);

      const passengerExists = await prisma.passenger.findUnique({
        where: { id: passengerId },
        select: { id: true, rootDriverId: true, referredByDriverId: true, user: { select: { name: true } } },
      });

      console.log("🔥 PASSENGER:", passengerExists);

      if (!passengerExists) {
        return res.status(404).json({ error: "Passenger not found" });
      }

      const rootDriverId = passengerExists.rootDriverId;
      const initialDispatchStage: "OWNER_DISPATCH" | "NETWORK_DISPATCH" =
        rootDriverId ? "OWNER_DISPATCH" : "NETWORK_DISPATCH";

      const rideKind: "IMMEDIATE" | "SCHEDULED" =
        scheduledAt === undefined || scheduledAt === null || scheduledAt === ""
          ? "IMMEDIATE"
          : "SCHEDULED";

      let date: Date | null = null;
      if (rideKind === "SCHEDULED") {
        date = new Date(scheduledAt as string);
        if (isNaN(date.getTime())) {
          return res.status(400).json({
            error: "Invalid scheduledAt",
            details: "Use um formato ISO, por exemplo: 2026-04-22T14:00:00.000Z",
          });
        }

        if (date <= new Date()) {
          return res.status(400).json({ error: "scheduledAt must be a future date" });
        }
      }

      // Fase E — M1 é SOMENTE o motorista que indicou o passageiro
      // (referredByDriverId). rootDriverId é ownership econômico (split V2),
      // nunca o M1. Corridas com M1 são quote-gated: sem origem M resolvível
      // no modo da corrida, o POST é rejeitado (422) e NENHUM fallback
      // clássico / matching aberto é executado.
      const m1DriverId = passengerExists?.referredByDriverId ?? null;
      const rideMode: RideMode = rideKind === "SCHEDULED" ? "SCHEDULED" : "IMMEDIATE";

      let preResolvedOrigin: ResolvedOrigin | null = null;
      if (FEATURES.QUOTE_ENABLED && m1DriverId) {
        const originResolver = new DriverOriginResolver();
        preResolvedOrigin = await originResolver.resolveOriginForDriver({
          driverId: m1DriverId,
          rideLat: resolvedOriginLat,
          rideLng: resolvedOriginLng,
          mode: rideMode,
        });

        if (!preResolvedOrigin.resolved) {
          return res.status(422).json({
            error: "Origem do motorista M1 não resolvida — quote indisponível",
            code: "QUOTE_UNAVAILABLE",
            details: preResolvedOrigin.reason,
            mode: rideMode,
          });
        }
      }

      const CONFLICT_WINDOW_MS = 30 * 60 * 1000;
      const windowStart = date ? new Date(date.getTime() - CONFLICT_WINDOW_MS) : null;
      const windowEnd   = date ? new Date(date.getTime() + CONFLICT_WINDOW_MS) : null;

      const conflictingRide = windowStart && windowEnd
        ? await prisma.rideRequest.findFirst({
            where: {
              passengerId,
              scheduledAt: { gte: windowStart, lte: windowEnd },
              status: { in: ["PENDING", "ACCEPTED", "IN_PROGRESS"] },
            },
          })
        : null;

      if (conflictingRide) {
        return res.status(409).json({
          error: "Você já possui uma corrida agendada nesse horário.",
          code: "SCHEDULE_CONFLICT",
          conflictingRideId: conflictingRide.id,
        });
      }

      const safeContext: Prisma.InputJsonValue = {
        isVip:     context.isVip     ?? false,
        isAirport: context.isAirport ?? false,
        isPet:     context.isPet     ?? false,
        isLuggage: context.isLuggage ?? false,
      };

      const policy = AcceptancePolicyEngine.computePolicy(date);
      const ownershipReferenceDate = date ?? new Date();
      const ownershipPolicyRepo = new OwnershipPolicyRepository(prisma);
      const ownershipPolicy = await ownershipPolicyRepo.resolveForRide(ownershipReferenceDate);
      const ownerResolution = ownershipPolicy
        ? resolveOwnershipV2({
            policy: ownershipPolicy,
            strategyInput: { passengerRootDriverId: rootDriverId ?? null },
          })
        : // Fallback V1 se nenhuma política estiver vigente (não deve ocorrer em produção)
          { ownerId: rootDriverId ?? null, ownerType: rootDriverId ? "ROOT_DRIVER" as const : "NONE" as const,
            ownershipPolicyCode: "PASSENGER_ROOTDRIVER_DIRECT", ownershipPolicyId: null,
            ownershipPolicyVersion: null, ownershipResolutionVersion: 1,
            resolutionSource: "passenger.rootDriverId" };

      // Corrida + OwnershipSnapshot em uma transação — snapshot imutável desde o início
      const ride = await prisma.$transaction(async (tx) => {
        const created = await tx.rideRequest.create({
          data: {
            passengerId,
            origin: originTrimmed,
            destination: destinationTrimmed,
            scheduledAt: date,
            operationalCutoffAt: policy.operationalCutoffAt,
            status: "PENDING",
            currentDispatchStage: initialDispatchStage,
            distanceKm,
            durationMin: estimatedDurationMin,
            priceEstimated,
            // Decision B — coordinates resolved server-side (authoritative) or
            // pass-through from the client when no Google key is configured.
            originLat: resolvedOriginLat,
            originLng: resolvedOriginLng,
            destinationLat: resolvedDestLat,
            destinationLng: resolvedDestLng,
            originPlaceId: authoritativeOrigin.providerPlaceId,
            destinationPlaceId: authoritativeDestination.providerPlaceId,
            rootDriverId,
            context: safeContext,
            // Pricing Snapshot — ADR-001 §5 (null when engine disabled or errored)
            baseCOE:         ridePricing?.baseCOE         ?? null,
            zoneMultiplier:  ridePricing?.zoneMultiplier  ?? null,
            liquidityMargin: ridePricing?.liquidityMargin ?? null,
            liquidityAmount: ridePricing?.liquidityAmount ?? null,
            baseFare:        ridePricing?.baseFare        ?? null,
            platformFee:     ridePricing?.platformFee     ?? null,
            driverNetAmount: ridePricing?.driverNetAmount ?? null,
            pricingVersion:  ridePricing?.pricingVersion  ?? null,
          },
          include: {
            passenger: { include: { user: { select: PUBLIC_USER_SELECT } } },
            offers: true,
            selectedDriver: { include: { user: { select: PUBLIC_USER_SELECT } } },
          },
        });

        // ADR-004: OwnershipSnapshot persistido na mesma transação — imutável daqui em diante
        await tx.ownershipSnapshot.create({
          data: {
            rideId:                      created.id,
            ownerId:                     ownerResolution.ownerId,
            ownerType:                   ownerResolution.ownerType,
            ownershipPolicyCode:         ownerResolution.ownershipPolicyCode,
            ownershipPolicyId:           ownerResolution.ownershipPolicyId,
            ownershipPolicyVersion:      ownerResolution.ownershipPolicyVersion,
            ownershipResolutionVersion:  ownerResolution.ownershipResolutionVersion,
            resolutionSource:            ownerResolution.resolutionSource,
          },
        });

        return created;
      });

      logMatchingEvent({
        rideId: ride.id,
        event: "ACCEPTANCE_WINDOW_CALCULATED",
        metadata: {
          isScheduled: policy.isScheduled,
          operationalCutoffAt: policy.operationalCutoffAt?.toISOString() ?? null,
          offerResponseTimeoutMs: policy.offerResponseTimeoutMs,
          referralWindowMs: policy.referralWindowMs,
        },
      });

      console.log("RIDE CREATED:", {
        id: ride.id,
        status: ride.status,
        dispatchStage: ride.currentDispatchStage,
        rootDriverId: ride.rootDriverId,
      });

      // Fase E (bifase) — POST /rides emite a RideQuote QUOTED e ZERO ofertas.
      // A confirmação do passageiro (POST /rides/:id/confirm-quote) transita
      // QUOTED → AGREED e só então a primeira oferta é criada. Nenhum dispatch
      // assíncrono é iniciado para corridas com M1.
      let quoteIssued = false;
      let rideQuote = null;

      if (FEATURES.QUOTE_ENABLED && m1DriverId) {
        const issuer = new RideQuoteIssuer();
        const issued = await issuer.issueForRide(ride.id, {
          mode: rideMode,
          preResolvedOrigin: preResolvedOrigin ?? undefined,
          priceAtoBReais: priceEstimated,
        });

        if (!issued.issued) {
          await this.rollbackRideCreation(ride.id);
          return res.status(422).json({
            error: "Quote indisponível para o motorista M1",
            code: "QUOTE_UNAVAILABLE",
            details: issued.reason,
            mode: rideMode,
          });
        }

        quoteIssued = true;
        rideQuote = await prisma.rideQuote.findUnique({
          where: { id: issued.quoteId },
        });
        logMatchingEvent({
          rideId: ride.id,
          event: "QUOTE_ISSUED",
          stage: "REFERRAL_DIRECT",
          candidateDriverIds: [m1DriverId],
          metadata: {
            quoteStatus: "QUOTED",
            grossFinalCents: issued.grossFinalCents,
            driverReceivableAmountCents: issued.driverReceivableAmountCents,
          },
        });
      }

      if (!quoteIssued) {
        matchingJobScheduler.schedule(ride.id, async () => {
          try {
            console.log(`🚀 Iniciando matching para ride ${ride.id}`);
            const matchRideUseCase = new MatchRideUseCase();
            await matchRideUseCase.execute({ rideId: ride.id, candidateDriverIds });
            console.log(`✅ Matching finalizado para ride ${ride.id}`);
          } catch (error) {
            console.error(`🔥 Erro no matching da ride ${ride.id}:`, error);
          }
        });
      }

      // RideQuote DTO — ADR-001 §5 Pricing Snapshot exposed to frontend.
      // Frontend only renders these values — never recalculates.
      const quote = ridePricing ? {
        baseCOE:             ridePricing.baseCOE,
        zoneMultiplier:      ridePricing.zoneMultiplier,
        liquidityMargin:     ridePricing.liquidityMargin,
        liquidityAmount:     ridePricing.liquidityAmount,
        baseFare:            ridePricing.baseFare,
        driverNetAmount:     ridePricing.driverNetAmount,
        platformFee:         ridePricing.platformFee,
        totalPassengerPrice: ridePricing.totalPassengerPrice,
        distanceKm:          ridePricing.distanceKm,
        estimatedDurationMin: ridePricing.estimatedDurationMin,
        pricingVersion:      ridePricing.pricingVersion,
        breakdown:           ridePricing.breakdown,
      } : null;

      return res.status(201).json({
        message: "Corrida criada com sucesso",
        ride,
        quote,
        rideQuote,
      });
    } catch (error) {
      console.error("🔥 ERRO REAL:", error);
      return res.status(500).json({
        error: "Erro ao criar corrida",
        details: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * Rollback scoped à própria requisição: quando a quote de uma corrida M1 não
   * pode ser emitida, a corrida recém-criada é desfeita (quote + ownership
   * snapshot + ride) para não deixar órfã em PENDING sem oferta nem dispatch.
   */
  private async rollbackRideCreation(rideId: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.rideQuote.deleteMany({ where: { rideRequestId: rideId } });
      await tx.ownershipSnapshot.deleteMany({ where: { rideId } });
      await tx.rideRequest.deleteMany({ where: { id: rideId } });
    });
  }

  /**
   * Fase E (bifase) — confirmação do passageiro sobre a quote QUOTED:
   * CAS QUOTED → AGREED e, na sequência, a primeira oferta para o M1 é criada
   * (EnsureFirstOfferService). Idempotente: retry após AGREED retorna o mesmo
   * contrato e não duplica oferta.
   */
  async confirmQuote(req: Request, res: Response) {
    try {
      const { id } = req.params;

      if (!id || typeof id !== "string") {
        return res.status(400).json({ error: "Ride id inválido" });
      }

      const ride = await prisma.rideRequest.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!ride) {
        return res.status(404).json({ error: "Corrida não encontrada" });
      }

      const quote = await prisma.rideQuote.findFirst({
        where: { rideRequestId: id },
        orderBy: { createdAt: "desc" },
      });
      if (!quote) {
        return res.status(404).json({
          error: "Nenhuma quote para esta corrida",
          code: "QUOTE_NOT_FOUND",
        });
      }

      const quoteService = new RideQuoteService();
      const confirmed = await quoteService.confirmQuote({
        rideRequestId: id,
        pricingDriverId: quote.pricingDriverId,
        expectedVersion: quote.version,
      });

      if (confirmed.outcome !== "AGREED") {
        const code =
          confirmed.outcome === "EXPIRED" ? "QUOTE_EXPIRED" : "QUOTE_CONFLICT";
        return res.status(409).json({
          error: "Quote não pode ser confirmada",
          code,
          details: confirmed.outcome,
        });
      }

      const ensurer = new EnsureFirstOfferService();
      const firstOffer = await ensurer.execute(id);

      if (!firstOffer.offered && firstOffer.reason === "RIDE_NOT_MATCHABLE") {
        return res.status(409).json({
          error: "Corrida não está mais disponível para oferta",
          code: "RIDE_NOT_MATCHABLE",
        });
      }

      const updatedRide = await prisma.rideRequest.findUnique({
        where: { id },
        include: {
          passenger: { include: { user: { select: PUBLIC_USER_SELECT } } },
          offers: true,
          selectedDriver: { include: { user: { select: PUBLIC_USER_SELECT } } },
        },
      });
      const agreedQuote = await prisma.rideQuote.findFirst({
        where: { rideRequestId: id, status: "AGREED" },
        orderBy: { createdAt: "desc" },
      });

      return res.status(200).json({
        message: "Quote confirmada — primeira oferta emitida",
        ride: updatedRide,
        rideQuote: agreedQuote,
        firstOfferId: firstOffer.offered ? firstOffer.offerId : null,
      });
    } catch (error) {
      console.error("🔥 ERRO CONFIRM QUOTE:", error);
      return res.status(500).json({
        error: "Erro ao confirmar quote",
        details: error instanceof Error ? error.message : error,
      });
    }
  }

  async patch(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { action } = req.body;

      if (!id || typeof id !== "string") {
        return res.status(400).json({ error: "Ride id inválido" });
      }

      if (action === "reschedule") {
        return this.reschedule(req, res);
      }

      if (action !== "reject_referral") {
        return res.status(400).json({ error: "Ação não suportada. Use action: 'reject_referral' ou 'reschedule'" });
      }

      const ride = await prisma.rideRequest.findUnique({
        where: { id },
        select: {
          currentDispatchStage: true,
          passenger: { select: { referredByDriverId: true } },
        },
      });

      if (!ride) {
        return res.status(404).json({ error: "Corrida não encontrada" });
      }

      if (ride.currentDispatchStage !== "OWNER_DISPATCH") {
        return res.status(409).json({
          error: "Corrida não está em OWNER_DISPATCH",
          currentDispatchStage: ride.currentDispatchStage,
        });
      }

      const referredDriverId = ride.passenger.referredByDriverId;

      if (referredDriverId) {
        await prisma.rideOffer.updateMany({
          where: { rideRequestId: id, driverId: referredDriverId, status: "PENDING" },
          data: { status: "EXPIRED" },
        });
      }

      await prisma.rideRequest.update({
        where: { id },
        data: { currentDispatchStage: "NETWORK_DISPATCH" },
      });

      console.log(`🔄 Fallback manual disparado para corrida ${id}`);

      matchingJobScheduler.schedule(id, async () => {
        try {
          const matchRideUseCase = new MatchRideUseCase();
          const { matched } = await matchRideUseCase.execute({
            rideId: id,
            level: "NETWORK_L1",
            excludedDriverIds: referredDriverId ? [referredDriverId] : [],
          });

          if (!matched) {
            await prisma.rideRequest.update({
              where: { id },
              data: { status: "CANCELLED" },
            });
            console.log(`⏱️ Corrida ${id} expirada — sem drivers no fallback manual`);
          }
        } catch (err) {
          console.error(`🔥 Erro no fallback manual da corrida ${id}:`, err);
        }
      });

      return res.status(200).json({
        message: "Fallback iniciado — corrida será atribuída a outro motorista",
        rideId: id,
      });
    } catch (error) {
      console.error("🔥 ERRO PATCH RIDE:", error);
      return res.status(500).json({
        error: "Erro ao processar fallback",
        details: error instanceof Error ? error.message : error,
      });
    }
  }

  async reschedule(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { newScheduledAt, newOrigin, newDestination, driverId: requestingDriverId } = req.body;

      if (!id || typeof id !== "string") {
        return res.status(400).json({ error: "Ride id inválido" });
      }

      if (!requestingDriverId || typeof requestingDriverId !== "string") {
        return res.status(400).json({ error: "driverId (requesting driver) é obrigatório" });
      }

      if (!newScheduledAt) {
        return res.status(400).json({ error: "newScheduledAt é obrigatório" });
      }

      const date = new Date(newScheduledAt);
      if (isNaN(date.getTime())) {
        return res.status(400).json({ error: "newScheduledAt inválido (use ISO string)" });
      }

      const useCase = new RescheduleRideUseCase();
      await useCase.execute({
        rideId: id,
        newScheduledAt: date,
        newOrigin,
        newDestination,
        requestingDriverId,
      });

      const updatedRide = await prisma.rideRequest.findUnique({
        where: { id },
        include: {
          passenger: { include: { user: { select: PUBLIC_USER_SELECT } } },
          offers: true,
          selectedDriver: { include: { user: { select: PUBLIC_USER_SELECT } } },
        },
      });

      return res.status(200).json({
        message: "Corrida reagendada com sucesso",
        ride: updatedRide,
      });
    } catch (error) {
      console.error("🔥 ERRO RESCHEDULE:", error);
      return res.status(500).json({
        error: "Erro ao reagendar corrida",
        details: error instanceof Error ? error.message : error,
      });
    }
  }

  async start(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { driverId } = req.body;

      if (!id || typeof id !== "string") {
        return res.status(400).json({ error: "Ride id inválido" });
      }

      if (!driverId || typeof driverId !== "string") {
        return res.status(400).json({ error: "driverId é obrigatório" });
      }

      const useCase = new StartRideUseCase();
      await useCase.execute({ rideId: id, driverId });

      const updatedRide = await prisma.rideRequest.findUnique({
        where: { id },
        include: {
          passenger: { include: { user: { select: PUBLIC_USER_SELECT } } },
          selectedDriver: { include: { user: { select: PUBLIC_USER_SELECT } } },
        },
      });

      return res.status(200).json({ message: "Corrida iniciada com sucesso", ride: updatedRide });
    } catch (error) {
      console.error("🔥 ERRO START RIDE:", error);
      return res.status(500).json({
        error: "Erro ao iniciar corrida",
        details: error instanceof Error ? error.message : error,
      });
    }
  }

  async complete(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { driverId } = req.body;

      if (!id || typeof id !== "string") {
        return res.status(400).json({ error: "Ride id inválido" });
      }

      if (!driverId || typeof driverId !== "string") {
        return res.status(400).json({ error: "driverId é obrigatório" });
      }

      const useCase = new CompleteRideUseCase();
      await useCase.execute({ rideId: id, driverId });

      const updatedRide = await prisma.rideRequest.findUnique({
        where: { id },
        include: {
          passenger: { include: { user: { select: PUBLIC_USER_SELECT } } },
          selectedDriver: { include: { user: { select: PUBLIC_USER_SELECT } } },
        },
      });

      return res.status(200).json({ message: "Corrida finalizada com sucesso", ride: updatedRide });
    } catch (error) {
      console.error("🔥 ERRO COMPLETE RIDE:", error);
      return res.status(500).json({
        error: "Erro ao finalizar corrida",
        details: error instanceof Error ? error.message : error,
      });
    }
  }

  async getById(req: AuthenticatedRideReadRequest, res: Response) {
    try {
      const { id } = req.params;

      if (!id || Array.isArray(id)) {
        return res.status(400).json({ error: "Ride id is required" });
      }

      console.log("🔥 BUSCANDO RIDE:", id);

      const access: Prisma.RideRequestWhereInput[] = [];
      if (req.authPassengerId) {
        access.push({ passengerId: req.authPassengerId });
      }
      if (req.authDriverId) {
        const driverRideStatuses = [
          "ACCEPTED",
          "IN_PROGRESS",
          "COMPLETED",
          "CANCELLED",
          "REJECTED",
          "EXPIRED",
          "PAID",
        ] as const;
        const terminalStatuses = ["COMPLETED", "CANCELLED", "REJECTED", "EXPIRED", "PAID"] as const;
        access.push(
          { selectedDriverId: req.authDriverId, status: { in: [...driverRideStatuses] } },
          {
            selectedDriverId: null,
            status: { in: [...terminalStatuses] },
            quotes: { some: { pricingDriverId: req.authDriverId } },
          },
        );
      }

      if (access.length === 0) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const ride = await prisma.rideRequest.findFirst({
        where: {
          id,
          OR: access,
        },
        include: this.rideReadInclude,
      });

      console.log("🔥 RIDE ENCONTRADA:", ride);

      if (!ride) {
        return res.status(404).json({ error: "Ride not found" });
      }

      return res.status(200).json(this.toRidePayload(ride));
    } catch (error) {
      console.error("🔥 ERRO GET:", error);
      return res.status(500).json({
        error: "Erro ao buscar corrida",
        details: error instanceof Error ? error.message : error,
      });
    }
  }
}
