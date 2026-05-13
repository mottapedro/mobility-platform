import { Request, Response } from "express";
import type { DriverRegion } from "@prisma/client";
import { prisma } from "../../infra/prisma/client";

export class DriverController {
  async getPublicProfile(req: Request, res: Response) {
    try {
      const { referralCode } = req.params;

      if (!referralCode || typeof referralCode !== "string") {
        return res.status(400).json({ error: "referralCode inválido na URL" });
      }

      const driver = await prisma.driver.findFirst({
        where: {
          referralCode,
          isActive: true,
        },
        select: {
          referralCode: true,
          experienceLevel: true,
          createdAt: true,
          user: {
            select: {
              name: true,
            },
          },
          regions: {
            select: {
              region: true,
            },
          },
          vehicles: {
            select: {
              brand: true,
              model: true,
              category: true,
            },
          },
        },
      });

      if (!driver) {
        return res.status(404).json({ error: "Motorista não encontrado" });
      }

      return res.status(200).json({
        name: driver.user.name,
        referralCode: driver.referralCode,
        experienceLevel: driver.experienceLevel,
        memberSince: driver.createdAt,
        regions: driver.regions.map((entry: Pick<DriverRegion, "region">) => entry.region),
        vehicles: driver.vehicles,
      });
    } catch (error) {
      console.error("Erro ao carregar perfil público do motorista:", error);
      return res.status(500).json({
        error: "Erro interno ao carregar motorista",
      });
    }
  }

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
        data: { userId: user.id, isActive: true, experienceLevel: level },
      });

      return res.status(201).json({ id: driver.id, referralCode: driver.referralCode, user });
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
        referralCode: d.referralCode,
        name: d.user.name,
        phone: d.user.phone,
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

  async listOffers(req: Request, res: Response) {
    try {
      const { driverId } = req.params;

      if (!driverId || typeof driverId !== "string") {
        return res.status(400).json({ error: "driverId inválido na URL" });
      }

      const driver = await prisma.driver.findUnique({ where: { id: driverId } });
      if (!driver) {
        return res.status(404).json({ error: "Driver não encontrado" });
      }

      // Retorna offers PENDING do driver com expiresAt no futuro
      // WAITING_REFERRAL é incluído para que o driver indicado veja sua oferta exclusiva
      const offers = await prisma.rideOffer.findMany({
        where: {
          driverId,
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
            include: {
              passenger: {
                include: { user: { select: { name: true, phone: true } } },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      return res.status(200).json(offers);
    } catch (error) {
      console.error("Erro ao listar ofertas do driver:", error);
      return res.status(500).json({
        error: "Erro interno ao listar ofertas",
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
