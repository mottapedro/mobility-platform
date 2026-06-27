import { prisma } from "../../../../infra/prisma/client";
import { PaymentStatus } from "../../../../shared/enums";

/**
 * Payload simplificado do webhook PicPay.
 * Ajustar campos conforme documentação oficial.
 */
export interface PicPayWebhookPayload {
  referenceId: string;
  status: string;
  paidAt?: string;
}

/**
 * ProcessPicPayWebhookUseCase — atualiza o PaymentIntent com base na
 * notificação do PicPay.
 */
export class ProcessPicPayWebhookUseCase {
  async execute(payload: PicPayWebhookPayload) {
    const { referenceId, status, paidAt } = payload;

    // Mapeamento conservador: PicPay pode usar 'PAID', 'COMPLETED' ou similar.
    const isPaid =
      status.toLowerCase() === "paid" ||
      status.toLowerCase() === "completed";

    const currentStatus = isPaid ? PaymentStatus.CONFIRMED : PaymentStatus.FAILED;

    await prisma.paymentIntent.updateMany({
      where: { externalId: referenceId },
      data: {
        status: currentStatus,
        ...(isPaid && paidAt ? { paidAt: new Date(paidAt) } : {}),
      },
    });
  }
}