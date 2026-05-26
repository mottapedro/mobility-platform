import { Request, Response } from "express";
import { prisma } from "../../infra/prisma/client";
import {
  createPaymentIntent,
  handlePixWebhook,
} from "../../domain/payment/PaymentIntentService";
import {
  getEventBus,
  getPixProvider,
} from "../../infrastructure/composition/paymentComposition";

export class PaymentController {
  async createIntent(req: Request, res: Response) {
    try {
      const rideId = String(req.params.id);
      const amountCents = Number(req.body?.amountCents);
      if (!Number.isInteger(amountCents) || amountCents <= 0) {
        return res.status(400).json({ error: "amountCents must be a positive integer" });
      }
      const intent = await createPaymentIntent({
        rideRequestId: rideId,
        amountCents,
        provider: getPixProvider(),
        bus: getEventBus(),
      });
      return res.status(201).json(intent);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) return res.status(404).json({ error: msg });
      console.error("createIntent error:", err);
      return res.status(500).json({ error: msg });
    }
  }

  async getSettlement(req: Request, res: Response) {
    const rideId = String(req.params.id);
    const settlement = await prisma.settlement.findUnique({
      where: { rideRequestId: rideId },
      include: { splits: true },
    });
    if (!settlement) return res.status(404).json({ error: "Settlement not found" });
    return res.status(200).json(settlement);
  }

  async pixWebhook(req: Request, res: Response) {
    const { externalId, status, failureReason } = req.body ?? {};
    if (!externalId || (status !== "CONFIRMED" && status !== "FAILED")) {
      return res.status(400).json({ error: "externalId and status (CONFIRMED|FAILED) required" });
    }
    try {
      const intent = await handlePixWebhook({
        externalId,
        status,
        failureReason,
        bus: getEventBus(),
      });
      return res.status(200).json(intent);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) return res.status(404).json({ error: msg });
      console.error("pixWebhook error:", err);
      return res.status(500).json({ error: msg });
    }
  }
}
