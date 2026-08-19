import { Request, Response } from "express";
import { randomBytes } from "crypto";
import { prisma } from "../../infra/prisma/client";
import {
  getPassengerNetwork,
  assignPassengerIdentity,
} from "../../domain/services/PassengerReferralService";
import { PUBLIC_USER_SELECT } from "../../shared/http/userPublic";

export class PassengerController {
  async create(req: Request, res: Response) {
    try {
      const { name, email, phone, referredByDriverId } = req.body;

      if (!name || !email || !phone) {
        return res.status(400).json({
          error: "Campos obrigatórios: name, email, phone",
        });
      }

      if (referredByDriverId !== undefined && referredByDriverId !== null) {
        if (typeof referredByDriverId !== "string") {
          return res.status(400).json({ error: "referredByDriverId deve ser uma string" });
        }

        const driver = await prisma.driver.findUnique({
          where: { id: referredByDriverId },
        });

        console.log("Driver encontrado:", driver?.id);

        if (!driver) {
          return res.status(404).json({
            error: "Driver indicado não encontrado",
            referredByDriverId,
          });
        }
      }

      const tmpSlug = `p-${randomBytes(8).toString("hex")}`;

      const passenger = await prisma.passenger.create({
        data: {
          referralCode: tmpSlug,
          publicSlug: tmpSlug,
          user: {
            create: {
              name,
              email,
              phone,
              role: "PASSENGER",
            },
          },
          ...(referredByDriverId
            ? { referredByDriver: { connect: { id: referredByDriverId } } }
            : {}),
        },
        include: {
          user: { select: PUBLIC_USER_SELECT },
          referredByDriver: {
            include: {
              user: { select: PUBLIC_USER_SELECT },
            },
          },
        },
      });

      await assignPassengerIdentity(passenger.id, name);

      const updated = await prisma.passenger.findUniqueOrThrow({
        where: { id: passenger.id },
        include: {
          user: { select: PUBLIC_USER_SELECT },
          referredByDriver: { include: { user: { select: PUBLIC_USER_SELECT } } },
        },
      });

      return res.status(201).json(updated);
    } catch (error) {
      console.error("🔥 Erro ao criar passageiro:", error);
      return res.status(500).json({
        error: "Erro interno ao criar passageiro",
        details: error instanceof Error ? error.message : error,
      });
    }
  }

  async getById(req: Request, res: Response) {
    try {
      const { id } = req.params;

      if (!id || typeof id !== "string") {
        return res.status(400).json({ error: "id inválido na URL" });
      }

      const passenger = await prisma.passenger.findUnique({
        where: { id },
        include: {
          user: { select: PUBLIC_USER_SELECT },
          referredByDriver: {
            include: {
              user: { select: PUBLIC_USER_SELECT },
              vehicles: true,
            },
          },
        },
      });

      if (!passenger) {
        return res.status(404).json({ error: "Passenger not found" });
      }

      console.log("Passenger carregado:", {
        id: passenger.id,
        referredByDriverId: passenger.referredByDriverId,
      });

      return res.json(passenger);
    } catch (error) {
      console.error("🔥 Erro ao buscar passageiro:", error);
      return res.status(500).json({
        error: "Erro interno ao buscar passageiro",
        details: error instanceof Error ? error.message : error,
      });
    }
  }

  async getNetwork(req: Request, res: Response) {
    try {
      const id = req.params.id as string;

      const passenger = await prisma.passenger.findUnique({
        where: { id },
        select: { id: true },
      });

      if (!passenger) {
        return res.status(404).json({ error: "Passenger not found" });
      }

      const network = await getPassengerNetwork(id);

      const totalReferrals = network.level1.length + network.level2.length + network.level3.length;

      const recentReferrals = await prisma.passenger.findMany({
        where: { referredByPassengerId: id },
        include: {
          user: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 5,
      });

      return res.json({
        totalReferrals,
        level1: network.level1,
        level2: network.level2,
        level3: network.level3,
        recentReferrals: recentReferrals.map((p) => ({
          id: p.id,
          name: p.user.name,
          createdAt: p.createdAt,
        })),
      });
    } catch (error) {
      console.error("🔥 Erro ao buscar network do passageiro:", error);
      return res.status(500).json({ error: "Erro interno ao buscar network" });
    }
  }

  async getHierarchy(req: Request, res: Response) {
    try {
      const id = req.params.id as string;

      const passenger = await prisma.passenger.findUnique({
        where: { id },
        include: {
          user: { select: { name: true } },
          referredByPassenger: {
            include: { user: { select: { name: true } } },
          },
          referrals: {
            include: { user: { select: { name: true } } },
          },
        },
      });

      if (!passenger) {
        return res.status(404).json({ error: "Passenger not found" });
      }

      const network = await getPassengerNetwork(id);
      const totalPassengers =
        1 + network.level1.length + network.level2.length + network.level3.length;

      let maxDepth = 0;
      if (network.level3.length > 0) maxDepth = 3;
      else if (network.level2.length > 0) maxDepth = 2;
      else if (network.level1.length > 0) maxDepth = 1;

      return res.json({
        me: {
          id: passenger.id,
          name: passenger.user.name,
          referralCode: passenger.referralCode ?? null,
          networkLevel: passenger.networkLevel,
        },
        referredBy: passenger.referredByPassenger
          ? {
              id: passenger.referredByPassenger.id,
              name: passenger.referredByPassenger.user.name,
            }
          : null,
        referrals: passenger.referrals.map((r) => ({
          id: r.id,
          name: r.user.name,
          networkLevel: r.networkLevel,
        })),
        totalPassengers,
        maxDepth,
      });
    } catch (error) {
      console.error("🔥 Erro ao buscar hierarquia do passageiro:", error);
      return res.status(500).json({ error: "Erro interno ao buscar hierarquia" });
    }
  }

  async resolveBySlug(req: Request, res: Response) {
    try {
      const slug = req.params.slug as string;

      const passenger = await prisma.passenger.findFirst({
        where: { publicSlug: slug },
        select: { id: true, referralCode: true, publicSlug: true, user: { select: { name: true } } },
      });

      if (!passenger) {
        return res.status(404).json({ error: "Passenger not found" });
      }

      return res.status(200).json(passenger);
    } catch (error) {
      console.error("🔥 Erro ao resolver slug do passageiro:", error);
      return res.status(500).json({ error: "Erro interno ao resolver slug" });
    }
  }
}
