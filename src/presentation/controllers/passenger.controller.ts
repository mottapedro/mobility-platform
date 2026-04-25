import { Request, Response } from "express";
import { prisma } from "../../infra/prisma/client";

export class PassengerController {
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
