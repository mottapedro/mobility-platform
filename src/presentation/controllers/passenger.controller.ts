import { Request, Response } from "express";
import { prisma } from "../../infra/prisma/client";

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

      const passenger = await prisma.passenger.create({
        data: {
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
          user: true,
          referredByDriver: {
            include: {
              user: true,
            },
          },
        },
      });

      return res.status(201).json(passenger);
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
          user: true,
          referredByDriver: {
            include: {
              user: true,
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
}
