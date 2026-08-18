import { Request, Response } from "express";
import { prisma } from "../../infra/prisma/client";
import { handlePixWebhook } from "../../domain/payment/PaymentIntentService";
import { resolveQuoteGrossCents } from "../../domain/ride-quote/RideQuoteService";
import { getEventBus } from "../../infrastructure/composition/paymentComposition";

// ─── PIX Estático EMVCo inline — chave EVP fixa ───────────────────────────────
const PIX_KEY = "91e47d2f-65f6-4b36-a33a-5af9ebc1c4e6";
const MERCHANT_NAME = "Aliado Mobilidade";
const MERCHANT_CITY = "Rio de Janeiro";

function tlv(tag: string, value: string): string {
  return `${tag}${String(value.length).padStart(2, "0")}${value}`;
}

function crc16(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function buildStaticPix(amountCents: number, txid: string): string {
  const amountBrl = (amountCents / 100).toFixed(2);
  const safeTxid = txid.replace(/[^A-Za-z0-9]/g, "").slice(0, 25) || "ALIADO";
  const mai = tlv("00", "BR.GOV.BCB.PIX") + tlv("01", PIX_KEY);
  const additionalData = tlv("05", safeTxid);
  const body =
    tlv("00", "01") +
    tlv("26", mai) +
    tlv("52", "0000") +
    tlv("53", "986") +
    tlv("54", amountBrl) +
    tlv("58", "BR") +
    tlv("59", MERCHANT_NAME.slice(0, 25)) +
    tlv("60", MERCHANT_CITY.slice(0, 15)) +
    tlv("62", additionalData) +
    "6304";
  return body + crc16(body);
}
// ──────────────────────────────────────────────────────────────────────────────

interface BreakdownItem {
  label: string;
  value: number;
}

interface PaymentIntentResponseDTO {
  success: boolean;
  rideId: string;
  intentId: string;
  externalId: string;
  totalPrice: number;
  amount: number;
  qrCode: string;
  breakdown: BreakdownItem[];
}

export class PaymentController {
  async createIntent(req: Request, res: Response) {
    try {
      const rideId = String(req.params.id);

      // ── Preço vem do banco (autoritativo) — nunca do body ───────────────────
      const ride = await prisma.rideRequest.findUnique({
        where: { id: rideId },
        select: { id: true, priceOffered: true, priceEstimated: true },
      });

      if (!ride) {
        return res.status(404).json({ error: `RideRequest ${rideId} not found` });
      }

      const priceBrl = ride.priceOffered ?? ride.priceEstimated;
      if (!priceBrl || priceBrl <= 0) {
        return res.status(422).json({
          error: "Ride has no computed price. PricingEngine must run at ride creation.",
          code: "MISSING_PRICE",
        });
      }

      // Fase E — quote viva é autoritativa (gross em centavos = snapshot imutável).
      const quoteCents = await resolveQuoteGrossCents(rideId);
      const amountCents = quoteCents ?? Math.round(priceBrl * 100);

      // ── Verificar/criar PaymentIntent no banco ────────────────────────────
      let intent = await prisma.paymentIntent.findUnique({
        where: { rideRequestId: rideId },
      });

      const needsQr = !intent || !intent.qrCode || intent.qrCode.includes("qr-code.picpay.com");

      if (!intent) {
        intent = await prisma.paymentIntent.create({
          data: { rideRequestId: rideId, amountCents },
        });
      }

      if (needsQr) {
        const qrCode = buildStaticPix(amountCents, intent.id);
        const externalId = `static_pix_${intent.id}`;
        console.log("✅ [INLINE PIX] EMVCo gerado:", { rideId, amountCents, qrCodePreview: qrCode.slice(0, 60) + "..." });
        intent = await prisma.paymentIntent.update({
          where: { id: intent.id },
          data: { qrCode, externalId, qrCodeImage: "" },
        });
      }

      // ── Breakdown financeiro (lido dos campos persistidos) ─────────────────
      const rideWithPricing = await prisma.rideRequest.findUnique({
        where: { id: rideId },
        select: { driverNetAmount: true, platformFee: true },
      });

      const totalPrice = Number((amountCents / 100).toFixed(2));

      let breakdown: BreakdownItem[];
      if (rideWithPricing?.driverNetAmount != null && rideWithPricing?.platformFee != null) {
        breakdown = [
          { label: "Serviço de Transporte", value: rideWithPricing.driverNetAmount },
          { label: "Taxa Cyborg",           value: rideWithPricing.platformFee },
        ];
      } else {
        // Fallback para corridas sem breakdown persistido (pre-PricingEngine)
        const platformFee = Number(parseFloat(process.env.PLATFORM_FEE_VALIDATION ?? "2.50").toFixed(2));
        const driverAmount = Number(Math.max(0, totalPrice - platformFee).toFixed(2));
        breakdown = [
          { label: "Serviço de Transporte", value: driverAmount },
          { label: "Taxa Cyborg",           value: platformFee },
        ];
      }

      console.log(`[INLINE PIX] Intent para corrida ${rideId}. Total: R$ ${totalPrice}`);

      const responseBody: PaymentIntentResponseDTO = {
        success:    true,
        rideId,
        intentId:   intent.id,
        externalId: intent.externalId ?? `static_pix_${intent.id}`,
        totalPrice,
        amount:     totalPrice,
        qrCode:     intent.qrCode ?? "",
        breakdown,
      };

      return res.status(201).json(responseBody);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) return res.status(404).json({ error: msg });
      console.error("createIntent error:", err);
      return res.status(500).json({ success: false, error: msg });
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
