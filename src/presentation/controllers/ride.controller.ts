import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../infra/prisma/client";
import { FEATURES } from "../../config/features";
import { MatchRideUseCase } from "../../application/use-cases/MatchRideUseCase";

// ─── Tipo do contexto da corrida (V1.3) ────────────────────────────────────
export interface RideContext {
  vip?:     boolean;
  airport?: boolean;
  pet?:     boolean;
  luggage?: boolean;
}

function validateContext(raw: unknown): RideContext | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  const allowed = ["vip", "airport", "pet", "luggage"];
  for (const key of Object.keys(c)) {
    if (!allowed.includes(key)) return null;
    if (c[key] !== undefined && typeof c[key] !== "boolean") return null;
  }
  return c as RideContext;
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

      // valida context (opcional)
      const context = validateContext(rawContext);
      if (rawContext !== undefined && context === null) {
        return res.status(400).json({
          error: "Invalid context",
          details: "context deve ser um objeto com campos opcionais: isAirport, isPet, isLuggage, isVip (boolean)",
        });
      }

      // valida passageiro
      const passengerExists = await prisma.passenger.findUnique({
        where: { id: passengerId },
        include: {
          user: true,
        },
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
          status: { in: ["PENDING", "MATCHING", "WAITING_DRIVER", "ACCEPTED"] },
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

      const safeContext: Prisma.InputJsonValue | undefined = context
        ? {
            vip:     context.vip     ?? false,
            airport: context.airport ?? false,
            pet:     context.pet     ?? false,
            luggage: context.luggage ?? false,
          }
        : undefined;

      const ride = await prisma.rideRequest.create({
        data: {
          passengerId,
          origin: originTrimmed,
          destination: destinationTrimmed,
          scheduledAt: date,
          distanceKm,
          durationMin,
          ...(safeContext !== undefined ? { context: safeContext } : {}),
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

      // 🚀 Dispara o matching em background (não bloqueia HTTP)
      setImmediate(async () => {
        try {
          console.log(`🚀 Iniciando matching para ride ${ride.id}`);
          const matchRideUseCase = new MatchRideUseCase();
          await matchRideUseCase.execute({ rideId: ride.id });
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