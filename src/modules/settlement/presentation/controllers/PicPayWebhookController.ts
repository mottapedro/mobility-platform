import { Request, Response } from "express";
import { ProcessPicPayWebhookUseCase } from "../../application/use-cases/ProcessPicPayWebhookUseCase";
import { PicPayWebhookPayload } from "../../application/use-cases/ProcessPicPayWebhookUseCase";

export class PicPayWebhookController {
  private readonly useCase: ProcessPicPayWebhookUseCase;

  constructor(useCase?: ProcessPicPayWebhookUseCase) {
    this.useCase = useCase ?? new ProcessPicPayWebhookUseCase();
  }

  async handle(req: Request, res: Response) {
    try {
      const payload = req.body as PicPayWebhookPayload;

      if (!payload || !payload.referenceId || !payload.status) {
        return res.status(400).json({ error: "Payload inválido: referenceId e status são obrigatórios." });
      }

      // Processa de forma assíncrona (fire-and-forget), retornando 200 imediato ao PicPay.
      // Se quiser garantir execução, usar uma fila/cron no futuro.
      this.useCase.execute(payload).catch((error) => {
        console.error("🔥 ERRO PROCESSANDO WEBHOOK PICPAY:", error);
      });

      return res.status(200).json({ received: true });
    } catch (error) {
      console.error("🔥 ERRO WEBHOOK PICPAY (controller):", error);
      return res.status(500).json({ error: "Erro ao processar webhook." });
    }
  }
}