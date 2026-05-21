import { Request, Response } from "express";
import { prisma } from "../../infra/prisma/client";
import { getDriverNetworkSnapshot } from "../../domain/services/DriverReferralService";

export class DriverController {
  private async findActivePublicDriver(referralCode: string) {
    return prisma.driver.findFirst({
      where: {
        referralCode,
        isActive: true,
      },
      select: {
        id: true,
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
  }

  async getPublicProfile(req: Request, res: Response) {
    try {
      const { referralCode } = req.params;

      if (!referralCode || typeof referralCode !== "string") {
        return res.status(400).json({ error: "referralCode inválido na URL" });
      }

      const driver = await this.findActivePublicDriver(referralCode);
      if (!driver) {
        return res.status(404).json({ error: "Motorista não encontrado" });
      }

      return res.status(200).json({
        name: driver.user.name,
        referralCode: driver.referralCode,
        experienceLevel: driver.experienceLevel,
        memberSince: driver.createdAt,
        regions: driver.regions.map((region) => region.region),
        vehicles: driver.vehicles,
      });
    } catch (error) {
      console.error("Erro ao carregar perfil público do motorista:", error);
      return res.status(500).json({
        error: "Erro interno ao carregar motorista",
      });
    }
  }

  async resolvePublicReferral(req: Request, res: Response) {
    try {
      const { slug } = req.params;

      if (!slug || typeof slug !== "string" || !slug.trim()) {
        return res.status(400).json({ error: "slug inválido na URL" });
      }

      const driver = await this.findActivePublicDriver(slug.trim());
      if (!driver) {
        return res.status(404).json({ error: "Motorista não encontrado" });
      }

      return res.status(200).json({
        slug: slug.trim(),
        referralCode: driver.referralCode,
        driver: {
          id: driver.id,
          name: driver.user.name,
          experienceLevel: driver.experienceLevel,
          memberSince: driver.createdAt,
        },
      });
    } catch (error) {
      console.error("Erro ao resolver slug público de referral:", error);
      return res.status(500).json({
        error: "Erro interno ao resolver referral público",
      });
    }
  }

  async create(req: Request, res: Response) {
    try {
      const { name, email, phone, experienceLevel, referralCode, referredByDriverId } = req.body;

      if (referralCode !== undefined || referredByDriverId !== undefined) {
        return res.status(410).json({
          error: "Cadastro com referral deve usar POST /auth/register",
        });
      }

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

  async getNetwork(req: Request, res: Response) {
    try {
      const { driverId } = req.params;

      if (!driverId || typeof driverId !== "string") {
        return res.status(400).json({ error: "driverId inválido na URL" });
      }

      const driver = await prisma.driver.findUnique({
        where: { id: driverId },
        select: { id: true, isActive: true },
      });

      if (!driver || !driver.isActive) {
        return res.status(404).json({ error: "Driver não encontrado ou inativo" });
      }

      const network = await getDriverNetworkSnapshot(driverId);
      return res.status(200).json(network);
    } catch (error) {
      console.error("Erro ao carregar rede do driver:", error);
      return res.status(500).json({
        error: "Erro interno ao carregar rede do driver",
        details: error instanceof Error ? error.message : error,
      });
    }
  }
}
