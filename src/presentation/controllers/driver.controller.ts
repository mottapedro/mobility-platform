import { Request, Response } from "express";
import { prisma } from "../../infra/prisma/client";
import { AuthenticatedDriverRequest } from "../middleware/requireDriverAuth";
import { buildDriverPublicSlug } from "../../domain/services/DriverIdentityService";
import { getDriverNetwork } from "../../domain/services/DriverReferralService";

export class DriverController {
  async create(req: Request, res: Response) {
    try {
      const { name, email, phone, experienceLevel } = req.body;

      if (!name || !email || !phone) {
        return res.status(400).json({
          error: "Campos obrigatórios: name, email, phone",
        });
      }

      if (
        typeof name !== "string" ||
        typeof email !== "string" ||
        typeof phone !== "string"
      ) {
        return res.status(400).json({ error: "name, email e phone devem ser strings" });
      }

      const validLevels = ["INICIANTE", "INTERMEDIARIO", "PROFISSIONAL", "ELITE"];
      const level = experienceLevel && validLevels.includes(experienceLevel)
        ? experienceLevel
        : "INICIANTE";

      const user = await prisma.user.create({
        data: { name, email, phone, role: "DRIVER" },
      });

      const driver = await prisma.driver.create({
        data: {
          userId: user.id,
          isActive: true,
          experienceLevel: level,
          publicSlug: buildDriverPublicSlug(name),
          referralCode: buildDriverPublicSlug(name),
        },
      });

      return res.status(201).json({ id: driver.id, user, referralCode: driver.referralCode, publicSlug: driver.publicSlug });
    } catch (error: unknown) {
      // Unique constraint: email duplicado
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === "P2002"
      ) {
        return res.status(409).json({ error: "E-mail já cadastrado" });
      }
      console.error("Erro ao criar driver:", error);
      return res.status(500).json({
        error: "Erro interno ao criar driver",
        details: error instanceof Error ? error.message : error,
      });
    }
  }

  async list(req: Request, res: Response) {
    try {
      const drivers = await prisma.driver.findMany({
        where: { isActive: true },
        include: {
          user: {
            select: { id: true, name: true, phone: true },
          },
        },
      });

      const result = drivers.map((d) => ({
        id: d.id,
        name: d.user.name,
        phone: d.user.phone,
        referralCode: d.referralCode,
        publicSlug: d.publicSlug,
      }));

      return res.status(200).json(result);
    } catch (error) {
      console.error("Erro ao listar motoristas:", error);
      return res.status(500).json({
        error: "Erro interno ao listar motoristas",
        details: error instanceof Error ? error.message : error,
      });
    }
  }

  async getOffers(req: Request, res: Response) {
    try {
      console.log("➡️ DRIVER OFFERS HIT");

      const { id } = req.params;

      if (!id || typeof id !== "string") {
        return res.status(400).json({ error: "driverId inválido na URL" });
      }

      const driver = await prisma.driver.findUnique({ where: { id } });
      if (!driver) {
        return res.status(404).json({ error: "Driver não encontrado" });
      }

      const offers = await prisma.rideOffer.findMany({
        where: {
          driverId: id,
          status: "PENDING",
          expiresAt: { gt: new Date() },
          rideRequest: {
            status: {
              notIn: ["EXPIRED", "CANCELLED", "COMPLETED", "ACCEPTED"],
            },
          },
        },
        include: {
          rideRequest: {
            select: {
              id: true,
              origin: true,
              destination: true,
              scheduledAt: true,
              status: true,
              passenger: {
                select: {
                  id: true,
                  user: {
                    select: {
                      name: true,
                      phone: true,
                    },
                  },
                },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      console.log("✅ offers loaded:", offers.length);

      const response = offers.map((offer) => ({
        id: offer.id,
        rideRequestId: offer.rideRequestId,
        driverId: offer.driverId,
        status: offer.status,
        expiresAt: offer.expiresAt,
        createdAt: offer.createdAt,
        rideRequest: offer.rideRequest,
      }));

      return res.status(200).json(response);
    } catch (error) {
      console.error("🔥 DRIVER OFFERS ERROR:", error);
      return res.status(500).json({
        error: "Erro ao carregar ofertas",
      });
    }
  }

  async getNetwork(req: AuthenticatedDriverRequest, res: Response) {
    try {
      const { id } = req.params;
      const authDriverId = req.authDriverId;

      if (!id || typeof id !== "string") {
        return res.status(400).json({ error: "driverId inválido na URL" });
      }

      if (!authDriverId) {
        return res.status(401).json({ error: "Driver authentication required" });
      }

      if (authDriverId !== id) {
        return res.status(403).json({ error: "Driver cannot access another network" });
      }

      const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
      const pageSize = Math.min(
        100,
        Math.max(1, Number.parseInt(String(req.query.pageSize ?? "20"), 10) || 20)
      );

      const [totalPassengers, passengers, driverNetwork] = await Promise.all([
        prisma.passenger.count({
          where: { referredByDriverId: id },
        }),
        prisma.passenger.findMany({
          where: { referredByDriverId: id },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                phone: true,
                createdAt: true,
              },
            },
          },
          orderBy: { user: { createdAt: "desc" } },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        getDriverNetwork(id),
      ]);

      // Enrich each page of passengers with ride stats
      const passengerIds = passengers.map((p) => p.id);
      const rideStats = await prisma.rideRequest.groupBy({
        by: ["passengerId"],
        where: { passengerId: { in: passengerIds }, status: "COMPLETED" },
        _count: { id: true },
        _max: { scheduledAt: true },
      });
      const rideStatMap = new Map(rideStats.map((r) => [r.passengerId, r]));
      const ridesCompleted = rideStats.reduce((sum, r) => sum + r._count.id, 0);
      const estimatedRevenue = ridesCompleted * 45; // flat estimate R$45/ride

      return res.status(200).json({
        stats: {
          totalPassengers,
          level1Drivers: driverNetwork.level1.length,
          level2Drivers: driverNetwork.level2.length,
          level3Drivers: driverNetwork.level3.length,
        },
        relations: driverNetwork,
        totalPassengers,
        ridesCompleted,
        estimatedRevenue,
        page,
        pageSize,
        passengers: passengers.map((passenger) => ({
          id: passenger.id,
          userId: passenger.userId,
          name: passenger.user.name,
          email: passenger.user.email,
          phone: passenger.user.phone,
          referredByDriverId: passenger.referredByDriverId,
          joinedAt: passenger.user.createdAt,
        })),
        recentPassengers: passengers.map((passenger) => ({
          id: passenger.id,
          name: passenger.user.name,
          ridesCount: rideStatMap.get(passenger.id)?._count.id ?? 0,
          lastRideAt: rideStatMap.get(passenger.id)?._max.scheduledAt?.toISOString() ?? null,
        })),
      });
    } catch (error) {
      console.error("Erro ao carregar rede do motorista:", error);
      return res.status(500).json({
        error: "Erro interno ao carregar rede do motorista",
        details: error instanceof Error ? error.message : error,
      });
    }
  }

  async listRides(req: Request, res: Response) {
    try {
      const { driverId } = req.params;

      if (!driverId || typeof driverId !== "string") {
        return res.status(400).json({ error: "driverId inválido na URL" });
      }

      const driver = await prisma.driver.findUnique({ where: { id: driverId } });
      if (!driver) {
        return res.status(404).json({ error: "Driver não encontrado" });
      }

      const rides = await prisma.rideRequest.findMany({
        where: {
          selectedDriverId: driverId,
          status: "ACCEPTED",
        },
        include: {
          passenger: {
            include: {
              user: { select: { name: true, phone: true } },
            },
          },
        },
        orderBy: { scheduledAt: "asc" },
      });

      return res.status(200).json(rides);
    } catch (error) {
      console.error("Erro ao listar corridas do driver:", error);
      return res.status(500).json({
        error: "Erro interno ao listar corridas",
        details: error instanceof Error ? error.message : error,
      });
    }
  }
}
