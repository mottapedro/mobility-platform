import { Request, Response } from "express";
import { RespondToRideOfferUseCase } from "../../application/use-cases/RespondToRideOfferUseCase";
import { prisma } from "../../infra/prisma/client"

export class OfferController {
  private prisma;

  constructor(prisma: any = null) {
    this.prisma = prisma || prisma;
  }

  async respond(req: Request, res: Response) {
    try {
      const { offerId, accept } = req.body;

      const useCase = new RespondToRideOfferUseCase();
      await useCase.execute(offerId, accept);

      return res.json({ message: "Resposta processada" });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: "Erro ao responder oferta" });
    }
  }
}