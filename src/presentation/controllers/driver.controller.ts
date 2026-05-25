import { Request, Response } from "express";
import { prisma } from "../../infra/prisma/client";
import { getDriverNetworkSnapshot } from "../../domain/services/DriverReferralService";
import { AuthenticatedDriverRequest } from "../middleware/requireDriverAuth";
import { getNetworkRelationships } from "../../domain/referral-network/NetworkGenealogyService";
import { listDriverSkills } from "../../domain/skills/DriverSkillService";
import { ReferralFlowType } from "@prisma/client";

export class DriverController {
  private async findActivePublicDriver(referralCodeOrSlug: string) {
    return prisma.driver.findFirst({
      where: {
        isActive: true,
        OR: [{ referralCode: referralCodeOrSlug }, { publicSlug: referralCodeOrSlug }],
      },
      select: {
        id: true,
        referralCode: true,
        publicSlug: true,
        experienceLevel: true,
        createdAt: true,
        isActive: true,
        user: { select: { name: true } },
        regions: true,
        vehicles: { select: { brand: true, model: true, category: true } },
      },
    });
  }

  // Perfil público: POST/GET que usa referralCode (mantido por compat)
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
        regions: driver.regions,
        vehicles: driver.vehicles,
      });
    } catch (error) {
      console.error("Erro ao carregar perfil público do motorista:", error);
      return res.status(500).json({ error: "Erro interno ao carregar motorista" });
    }
  }

  // Endpoint público canônico: /r/:slug
  async resolvePublicReferral(req: Request, res: Response) {
    try {
      const { slug } = req.params;

      if (!slug || typeof slug !== "string" || !slug.trim()) {
        return res.status(400).json({ error: "slug inválido na URL" });
      }

      const driver = await prisma.driver.findFirst({
        where: {
          isActive: true,
          publicSlug: slug.trim(),
        },
        select: {
          id: true,
          publicSlug: true,
          referralCode: true,
          experienceLevel: true,
          createdAt: true,
          user: { select: { name: true } },
        },
      });

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
      return res.status(500).json({ error: "Erro interno ao resolver referral público" });
    }
  }

  // GET /drivers/:driverId/network (canônico de leitura pública da rede)
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

  // Rotas restantes (offers/rides) - mantidas caso existam testes/consumo antigo
  async getNetworkHierarchy(req: Request, res: Response) {
    try {
      const { driverId } = req.params;

      if (!driverId || typeof driverId !== "string") {
        return res.status(400).json({ error: "driverId inválido na URL" });
      }

      const driver = await prisma.driver.findUnique({
        where: { id: driverId },
        select: {
          id: true,
          isActive: true,
          referralCode: true,
          publicSlug: true,
          user: { select: { name: true } },
        },
      });

      if (!driver || !driver.isActive) {
        return res.status(404).json({ error: "Driver não encontrado ou inativo" });
      }

      const snapshot = await getDriverNetworkSnapshot(driverId);

      return res.status(200).json({
        me: {
          id: driver.id,
          name: driver.user.name,
          referralCode: driver.referralCode,
          publicSlug: driver.publicSlug ?? null,
        },
        levels: snapshot.levels,
        summary: snapshot.summary,
        totalPassengers: snapshot.totalPassengers,
      });
    } catch (error) {
      console.error("Erro ao carregar hierarquia do driver:", error);
      return res.status(500).json({
        error: "Erro interno ao carregar hierarquia do driver",
        details: error instanceof Error ? error.message : error,
      });
    }
  }

  // V2: GET /drivers/:driverId/network/relationships
  async getNetworkRelationships(req: Request, res: Response) {
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

      const flowTypeParam = typeof req.query.flowType === "string" ? req.query.flowType : undefined;
      let flowType: ReferralFlowType | undefined;
      if (flowTypeParam) {
        if (!Object.values(ReferralFlowType).includes(flowTypeParam as ReferralFlowType)) {
          return res.status(400).json({ error: `flowType inválido. Use: ${Object.values(ReferralFlowType).join(", ")}` });
        }
        flowType = flowTypeParam as ReferralFlowType;
      }

      const response = await getNetworkRelationships(driverId, { flowType });
      return res.status(200).json(response);
    } catch (error) {
      console.error("Erro ao carregar relationships V2:", error);
      return res.status(500).json({
        error: "Erro interno ao carregar relationships",
        details: error instanceof Error ? error.message : error,
      });
    }
  }

  // V2: GET /drivers/:driverId/skills
  async getDriverSkills(req: Request, res: Response) {
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
      const skills = await listDriverSkills(driverId);
      return res.status(200).json({ driverId, skills });
    } catch (error) {
      console.error("Erro ao listar skills do driver:", error);
      return res.status(500).json({
        error: "Erro interno ao listar skills",
        details: error instanceof Error ? error.message : error,
      });
    }
  }

  async list(req: Request, res: Response) {
    try {
      const drivers = await prisma.driver.findMany({
        where: { isActive: true },
        select: {
          id: true,
          referralCode: true,
          publicSlug: true,
          isActive: true,
          user: {
            select: { id: true, name: true, phone: true },
          },
        },
      });

      return res.status(200).json(
        drivers.map((d) => ({
          id: d.id,
          referralCode: d.referralCode,
          name: d.user.name,
          phone: d.user.phone,
          publicSlug: d.publicSlug,
        }))
      );
    } catch (error) {
      console.error("Erro ao listar motoristas:", error);
      return res.status(500).json({
        error: "Erro interno ao listar motoristas",
        details: error instanceof Error ? error.message : error,
      });
    }
  }


  async getOffers(req: AuthenticatedDriverRequest, res: Response) {
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

      const offers = await prisma.rideOffer.findMany({
        where: { driverId: id, status: "PENDING" },
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
                  user: { select: { name: true, phone: true } },
                },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      return res.status(200).json(offers);
    } catch (error) {
      console.error("Erro ao carregar ofertas:", error);
      return res.status(500).json({
        error: "Erro ao carregar ofertas",
        details: error instanceof Error ? error.message : error,
      });
    }
  }

  async listOffers(req: Request, res: Response) {
    // compat: algumas rotas antigas chamam listOffers
    return res.status(410).json({ error: "Use autenticação do driver para offers" });
  }

  async listRides(req: Request, res: Response) {
    try {
      const { driverId } = req.params;

      if (!driverId || typeof driverId !== "string") {
        return res.status(400).json({ error: "driverId inválido na URL" });
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
