import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../infra/prisma/client";
import { FEATURES } from "../../config/features";
import { MatchRideUseCase } from "../../application/use-cases/MatchRideUseCase";
import { AcceptancePolicyEngine } from "../../domain/services/AcceptancePolicyEngine";
import { logMatchingEvent } from "../../shared/logging/matchingLog";
import { matchingJobScheduler } from "../../infra/async/MatchingJobScheduler";
import { RescheduleRideUseCase } from "../../application/use-cases/RescheduleRideUseCase";
import { StartRideUseCase } from "../../application/use-cases/StartRideUseCase";
import { CompleteRideUseCase } from "../../application/use-cases/CompleteRideUseCase";

// ─── Tipo do contexto da corrida ────────────────────────────────────────────
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


// ─── Haversine distance estimator ─────────────────────────────────────────
function haversineKm(
  lat1: number, lng1: number,
  lat2: number, lng2: number
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Price model: R$5 base flag + R$2.50/km (urban Brazil estimate)
const PRICE_BASE_BRL = 5.0;
const PRICE_PER_KM_BRL = 2.5;
// Duration estimate: avg 30 km/h in urban traffic
const AVG_SPEED_KMH = 30;

export class RideController {
  async create(req: Request, res: Response) {
    console.log("🚨 VERSÃO MELHORADA DO CONTROLLER");
    console.log("🔥 BODY:", req.body);

    try {
      const { passengerId, origin, destination, scheduledAt, context: rawContext, candidateDriverIds,
        originLat: rawOriginLat, originLng: rawOriginLng,
        destinationLat: rawDestLat, destinationLng: rawDestLng,
      } = req.body;

      // Parse coordinate pairs (body may use number or string; accept only numbers)
      const originLat      = typeof rawOriginLat === "number" ? rawOriginLat : null;
      const originLng      = typeof rawOriginLng === "number" ? rawOriginLng : null;
      const destinationLat = typeof rawDestLat   === "number" ? rawDestLat   : null;
      const destinationLng = typeof rawDestLng   === "number" ? rawDestLng   : null;

      // Compute estimates when all four coordinates are present
      let distanceKm: number | null = null;
      let durationMin: number | null = null;
      let priceEstimated: number | null = null;

      if (originLat !== null && originLng !== null && destinationLat !== null && destinationLng !== null) {
        distanceKm     = Math.round(haversineKm(originLat, originLng, destinationLat, destinationLng) * 10) / 10;
        durationMin    = Math.round((distanceKm / AVG_SPEED_KMH) * 60);
        priceEstimated = Math.round((PRICE_BASE_BRL + PRICE_PER_KM_BRL * distanceKm) * 100) / 100;
      }

      // validação básica
      if (!passengerId || !origin || !destination || !scheduledAt) {
        return res.status(400).json({
          error: "Missing fields",
          required: ["passengerId", "origin", "destination", "scheduledAt"],
        });
      }

      // valida tipos e conteúdo
      if (
        typeof passengerId !== "string" ||
        typeof origin !== "string" ||
        typeof destination !== "string" ||
        typeof scheduledAt !== "string"
      ) {
        return res.status(400).json({
          error: "Invalid field types",
          details:
            "passengerId, origin, destination e scheduledAt devem ser strings",
        });
      }

      const originTrimmed = origin.trim();
      const destinationTrimmed = destination.trim();

      if (!originTrimmed || !destinationTrimmed) {
        return res.status(400).json({
          error: "Origin and destination cannot be empty",
        });
      }

      if (originTrimmed.toLowerCase() === destinationTrimmed.toLowerCase()) {
        return res.status(400).json({
          error: "Origin and destination must be different",
        });
      }

      // normaliza context — aceita qualquer formato, nunca rejeita
      const context = normalizeContext(rawContext);

      // valida passageiro
      const passengerExists = await prisma.passenger.findUnique({
        where: { id: passengerId },
        select: { id: true, rootDriverId: true, user: { select: { name: true } } },
      });

      console.log("🔥 PASSENGER:", passengerExists);

      if (!passengerExists) {
        return res.status(404).json({
          error: "Passenger not found",
        });
      }

      // O dono da demanda é o rootDriver do passageiro.
      const rootDriverId = passengerExists.rootDriverId;
      const initialDispatchStage: "OWNER_DISPATCH" | "NETWORK_DISPATCH" = rootDriverId ? "OWNER_DISPATCH" : "NETWORK_DISPATCH";

      // valida data
      const date = new Date(scheduledAt);

      if (isNaN(date.getTime())) {
        return res.status(400).json({
          error: "Invalid scheduledAt",
          details: "Use um formato ISO, por exemplo: 2026-04-22T14:00:00.000Z",
        });
      }

      const now = new Date();

      if (date <= now) {
        return res.status(400).json({
          error: "scheduledAt must be a future date",
        });
      }

      // ─── FASE 3: Validação de conflito de horário ───────────────────────────
      const CONFLICT_WINDOW_MS = 30 * 60 * 1000; // 30 minutos
      const windowStart = new Date(date.getTime() - CONFLICT_WINDOW_MS);
      const windowEnd   = new Date(date.getTime() + CONFLICT_WINDOW_MS);

      const conflictingRide = await prisma.rideRequest.findFirst({
        where: {
          passengerId,
          scheduledAt: { gte: windowStart, lte: windowEnd },
          status: {
            in: [
              "PENDING",
              "ACCEPTED",
              "IN_PROGRESS",
            ],
          },
        },
      });

      if (conflictingRide) {
        return res.status(409).json({
          error: "Você já possui uma corrida agendada nesse horário.",
          code: "SCHEDULE_CONFLICT",
          conflictingRideId: conflictingRide.id,
        });
      }
      // ───────────────────────────────────────────────────────────────────────

      const safeContext: Prisma.InputJsonValue = {
        isVip:     context.isVip     ?? false,
        isAirport: context.isAirport ?? false,
        isPet:     context.isPet     ?? false,
        isLuggage: context.isLuggage ?? false,
      };

      const policy = AcceptancePolicyEngine.computePolicy(date);

      const ride = await prisma.rideRequest.create({
        data: {
          passengerId,
          origin: originTrimmed,
          destination: destinationTrimmed,
          scheduledAt: date,
          operationalCutoffAt: policy.operationalCutoffAt,
          status: "PENDING",
          currentDispatchStage: initialDispatchStage,
          distanceKm,
          durationMin,
          priceEstimated,
          originLat,
          originLng,
          destinationLat,
          destinationLng,
          rootDriverId: rootDriverId,
          context: safeContext,
        },
        include: {
          passenger: {
            include: {
              user: true,
            },
          },
          offers: true,
          selectedDriver: {
            include: {
              user: true,
            },
          },
        },
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

      // 🚀 Dispara o matching em background (não bloqueia HTTP)
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

      return res.status(201).json({
        message: "Corrida criada com sucesso",
        ride,
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

      // Expirar offer pendente do motorista dono
      if (referredDriverId) {
        await prisma.rideOffer.updateMany({
          where: { rideRequestId: id, driverId: referredDriverId, status: "PENDING" },
          data: { status: "EXPIRED" },
        });
      }

      // OWNER_DISPATCH → NETWORK_DISPATCH
      await prisma.rideRequest.update({
        where: { id },
        data: { currentDispatchStage: "NETWORK_DISPATCH" },
      });

      console.log(`🔄 Fallback manual disparado para corrida ${id}`);

      // Dispara matching geral excluindo o driver dono
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
      const result = await useCase.execute({
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

      return res.status(200).json({
        message: "Corrida iniciada com sucesso",
        ride: updatedRide,
      });
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

      return res.status(200).json({
        message: "Corrida finalizada com sucesso",
        ride: updatedRide,
      });
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
        return res.status(400).json({
          error: "Ride id is required",
        });
      }

      console.log("🔥 BUSCANDO RIDE:", id);

      const ride = await prisma.rideRequest.findUnique({
        where: { id },
        include: {
          passenger: {
            include: {
              user: true,
            },
          },
          offers: {
            include: {
              driver: {
                include: {
                  user: true,
                },
              },
            },
          },
          selectedDriver: {
            include: {
              user: true,
            },
          },
        },
      });

      console.log("🔥 RIDE ENCONTRADA:", ride);

      if (!ride) {
        return res.status(404).json({
          error: "Ride not found",
        });
      }

      // Map priceEstimated/priceOffered → priceBrl to match frontend Ride type.
      // Same pattern as getDriverOffers in driver.controller.ts.
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