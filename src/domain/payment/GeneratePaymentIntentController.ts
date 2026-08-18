import { Request, Response } from "express";
import { GeneratePaymentIntentUseCase } from "../../application/use-cases/GeneratePaymentIntentUseCase";

export class GeneratePaymentIntentController {
  async generate(req: Request, res: Response) {
    try {
      const rideId = req.params.id;
      const { amount } = req.body;

      if (!rideId || typeof rideId !== "string") {
        return res.status(400).json({ error: "rideId é obrigatório" });
      }

      // amount é opcional — se não vier, o use case recupera do RideRequest
      const useCase = new GeneratePaymentIntentUseCase();
      const result = amount
        ? await useCase.execute({ rideId, amount })
        : await useCase.execute({ rideId });

      return res.status(200).json({
        message: "PaymentIntent gerado com sucesso",
        ...result,
      });
    } catch (error) {
      console.error("🔥 ERRO GENERATE PAYMENT INTENT:", error);
      return res.status(500).json({
        error: "Erro ao gerar PaymentIntent",
        details: error instanceof Error ? error.message : error,
      });
    }
  }
}