import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../infra/prisma/client";
import { FEATURES } from "../../config/features";
import { AdvanceRideDispatchUseCase } from "../../application/use-cases/AdvanceRideDispatchUseCase";
import { MatchRideUseCase } from "../../application/use-cases/MatchRideUseCase";
import { logError, logInfo } from "../../shared/logger";

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


let distanceKm: number | null = null;
let durationMin: number | null = null;

if (FEATURES.DISTANCE_CALC_ENABLED) {
  // FUTURO: integração Google Maps
  // distanceKm = ...
  // durationMin = ...
}

export class RideController {
  async create(req: Request, res: Response) {
    console.log("🚨 VERSÃO MELHORADA DO CONTROLLER");
    console.log("🔥 BODY:", req.body);

    try {
      const { passengerId, origin, destination, scheduledAt, context: rawContext } = req.body;

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
        select: { id: true, referredByDriverId: true, user: { select: { name: true } } },
      });

      console.log("🔥 PASSENGER:", passengerExists);

      if (!passengerExists) {
        return res.status(404).json({
          error: "Passenger not found",
        });
      }

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
          status: { in: ["PENDING", "MATCHING", "WAITING_REFERRAL", "WAITING_DRIVER", "ACCEPTED"] },
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

      const ride = await prisma.rideRequest.create({
        data: {
          passengerId,
          origin: originTrimmed,
          destination: destinationTrimmed,
          scheduledAt: date,
          status: "PENDING",
          distanceKm,
          durationMin,
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

      logInfo("ride.dispatch.created", {
        id: ride.id,
        status: "PENDING",
        targetDriverId: passengerExists.referredByDriverId ?? null,
      });

      setImmediate(async () => {
        try {
          const matchRideUseCase = new MatchRideUseCase();
          await matchRideUseCase.execute({ rideId: ride.id });
        } catch (error) {
          logError("ride.dispatch.start_failed", error, { rideId: ride.id });
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

      if (action !== "reject_referral") {
        return res.status(400).json({ error: "Ação não suportada. Use action: 'reject_referral'" });
      }

      const ride = await prisma.rideRequest.findUnique({
        where: { id },
        select: {
          status: true,
          passenger: { select: { referredByDriverId: true } },
        },
      });

      if (!ride) {
        return res.status(404).json({ error: "Corrida não encontrada" });
      }

      if (ride.status !== "WAITING_REFERRAL") {
        return res.status(409).json({
          error: "Corrida não está em WAITING_REFERRAL",
          currentStatus: ride.status,
        });
      }

      const referredDriverId = ride.passenger.referredByDriverId;

      // Expirar offer pendente do driver indicado
      if (referredDriverId) {
        await prisma.rideOffer.updateMany({
          where: { rideRequestId: id, driverId: referredDriverId, status: "PENDING" },
          data: { status: "EXPIRED" },
        });
      }

      setImmediate(async () => {
        try {
          const advanceRideDispatchUseCase = new AdvanceRideDispatchUseCase();
          await advanceRideDispatchUseCase.execute({
            rideId: id,
            excludedDriverIds: referredDriverId ? [referredDriverId] : [],
          });
        } catch (err) {
          logError("ride.dispatch.manual_fallback_failed", err, { rideId: id });
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

      return res.status(200).json(ride);
    } catch (error) {
      console.error("🔥 ERRO GET:", error);

      return res.status(500).json({
        error: "Erro ao buscar corrida",
        details: error instanceof Error ? error.message : error,
      });
    }
  }
}