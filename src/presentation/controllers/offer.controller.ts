import { Response } from "express";
import { RespondToRideOfferUseCase, OfferResponseError } from "../../application/use-cases/RespondToRideOfferUseCase";
import { AuthenticatedDriverRequest } from "../middleware/requireDriverAuth";

const ERROR_STATUS_MAP: Record<string, number> = {
  OFFER_NOT_FOUND: 404,
  OFFER_ALREADY_RESPONDED: 409,
  OFFER_CONFLICT: 409,
  OFFER_EXPIRED: 410,
};

export class OfferController {
  async respond(req: AuthenticatedDriverRequest, res: Response) {
    try {
      const { offerId } = req.params;
      const { accept } = req.body;

      // Validação de input
      if (!offerId || typeof offerId !== "string") {
        return res.status(400).json({ error: "offerId inválido na URL" });
      }

      if (typeof accept !== "boolean") {
        return res.status(400).json({
          error: "Campo 'accept' é obrigatório e deve ser boolean (true ou false)",
        });
      }

      if (!req.authDriverId) {
        return res.status(401).json({ error: "Driver authentication required" });
      }

      const useCase = new RespondToRideOfferUseCase();
      const result = await useCase.execute(offerId, accept, req.authDriverId);

      return res.json({
        message: result.accepted
          ? "Corrida aceita com sucesso"
          : "Oferta rejeitada — re-match em andamento",
        accepted: result.accepted,
      });

    } catch (error) {
      if (error instanceof OfferResponseError) {
        const status = ERROR_STATUS_MAP[error.code] ?? 400;
        return res.status(status).json({
          error: error.message,
          code: error.code,
        });
      }

      console.error("🔥 Erro ao responder oferta:", error);
      return res.status(500).json({
        error: "Erro interno ao processar resposta",
        details: error instanceof Error ? error.message : error,
      });
    }
  }
}
