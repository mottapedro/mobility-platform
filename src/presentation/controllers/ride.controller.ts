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
import { resolveOwnership } from "../../domain/ownership/OwnershipResolver";

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

export class RideController {
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

      if (!passengerId || !origin || !destination || !scheduledAt) {
        return res.status(400).json({
          error: "Missing fields",
          required: ["passengerId", "origin", "destination", "scheduledAt"],
        });
      }

      if (
        typeof passengerId !== "string" ||
        typeof origin !== "string" ||
        typeof destination !== "string" ||
        typeof scheduledAt !== "string"
      ) {
        return res.status(400).json({
          error: "Invalid field types",
          details: "passengerId, origin, destination e scheduledAt devem ser strings",
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

      // ─── RouteCalculator → distância e duração ─────────────────────────────
      const route = await routeCalc.calculate(
        { lat: rawOriginLat, lng: rawOriginLng },
        { lat: rawDestLat, lng: rawDestLng },
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
        select: { id: true, rootDriverId: true, user: { select: { name: true } } },
      });

      console.log("🔥 PASSENGER:", passengerExists);

      if (!passengerExists) {
        return res.status(404).json({ error: "Passenger not found" });
      }

      const rootDriverId = passengerExists.rootDriverId;
      const initialDispatchStage: "OWNER_DISPATCH" | "NETWORK_DISPATCH" =
        rootDriverId ? "OWNER_DISPATCH" : "NETWORK_DISPATCH";

      const date = new Date(scheduledAt);
      if (isNaN(date.getTime())) {
        return res.status(400).json({
          error: "Invalid scheduledAt",
          details: "Use um formato ISO, por exemplo: 2026-04-22T14:00:00.000Z",
        });
      }

      if (date <= new Date()) {
        return res.status(400).json({ error: "scheduledAt must be a future date" });
      }

      const CONFLICT_WINDOW_MS = 30 * 60 * 1000;
      const windowStart = new Date(date.getTime() - CONFLICT_WINDOW_MS);
      const windowEnd   = new Date(date.getTime() + CONFLICT_WINDOW_MS);

      const conflictingRide = await prisma.rideRequest.findFirst({
        where: {
          passengerId,
          scheduledAt: { gte: windowStart, lte: windowEnd },
          status: { in: ["PENDING", "ACCEPTED", "IN_PROGRESS"] },
        },
      });

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

      // ADR-004: resolver ownership antes da persistência
      const ownerResolution = resolveOwnership({
        passengerRootDriverId: rootDriverId ?? null,
      });

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
            originLat: rawOriginLat,
            originLng: rawOriginLng,
            destinationLat: rawDestLat,
            destinationLng: rawDestLng,
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
            passenger: { include: { user: true } },
            offers: true,
            selectedDriver: { include: { user: true } },
          },
        });

        // ADR-004: OwnershipSnapshot persistido na mesma transação — imutável daqui em diante
        await tx.ownershipSnapshot.create({
          data: {
            rideId:                      created.id,
            ownerId:                     ownerResolution.ownerId,
            ownerType:                   ownerResolution.ownerType,
            ownershipPolicyCode:         ownerResolution.ownershipPolicyCode,
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

      matchingJobScheduler.schedule(async () => {
        try {
          console.log(`🚀 Iniciando matching para ride ${ride.id}`);
          const matchRideUseCase = new MatchRideUseCase();
          await matchRideUseCase.execute({ rideId: ride.id, candidateDriverIds });
          console.log(`✅ Matching finalizado para ride ${ride.id}`);
        } catch (error) {
          console.error(`🔥 Erro no matching da ride ${ride.id}:`, error);
        }
      });

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
      });
    } catch (error) {
      console.error("🔥 ERRO REAL:", error);
      return res.status(500).json({
        error: "Erro ao criar corrida",
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

      matchingJobScheduler.schedule(async () => {
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
          passenger: { include: { user: true } },
          offers: true,
          selectedDriver: { include: { user: true } },
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
          passenger: { include: { user: true } },
          selectedDriver: { include: { user: true } },
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
          passenger: { include: { user: true } },
          selectedDriver: { include: { user: true } },
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

  async getById(req: Request, res: Response) {
    try {
      const { id } = req.params;

      if (!id || Array.isArray(id)) {
        return res.status(400).json({ error: "Ride id is required" });
      }

      console.log("🔥 BUSCANDO RIDE:", id);

      const ride = await prisma.rideRequest.findUnique({
        where: { id },
        include: {
          passenger: { include: { user: true } },
          offers: {
            include: {
              driver: { include: { user: true } },
            },
          },
          selectedDriver: { include: { user: true } },
        },
      });

      console.log("🔥 RIDE ENCONTRADA:", ride);

      if (!ride) {
        return res.status(404).json({ error: "Ride not found" });
      }

      const payload = {
        ...ride,
        priceBrl: ride.priceOffered ?? ride.priceEstimated ?? null,
      };

      return res.status(200).json(payload);
    } catch (error) {
      console.error("🔥 ERRO GET:", error);
      return res.status(500).json({
        error: "Erro ao buscar corrida",
        details: error instanceof Error ? error.message : error,
      });
    }
  }
}
