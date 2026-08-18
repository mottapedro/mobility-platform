import { prisma } from "../../infra/prisma/client";
import { Prisma } from "@prisma/client";
import { MATCHABLE_RIDE_STATUSES, MatchRideUseCase } from "./MatchRideUseCase";
import { AcceptancePolicyEngine } from "../../domain/services/AcceptancePolicyEngine";
import { resolveQuoteGrossCents } from "../../domain/ride-quote/RideQuoteService";
import { logMatchingEvent } from "../../shared/logging/matchingLog";

// ─── PIX Estático EMVCo inline — sem injeção de dependência ──────────────────
const _PIX_KEY = "91e47d2f-65f6-4b36-a33a-5af9ebc1c4e6";
const _MERCHANT_NAME = "Aliado Mobilidade";
const _MERCHANT_CITY = "Rio de Janeiro";

function _tlv(tag: string, value: string): string {
  return `${tag}${String(value.length).padStart(2, "0")}${value}`;
}

function _crc16(s: string): string {
  let crc = 0xffff;
  for (let i = 0; i < s.length; i++) {
    crc ^= s.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function _buildStaticPix(amountCents: number, txid: string): string {
  const amountBrl = (amountCents / 100).toFixed(2);
  const safeTxid = txid.replace(/[^A-Za-z0-9]/g, "").slice(0, 25) || "ALIADO";
  const mai = _tlv("00", "BR.GOV.BCB.PIX") + _tlv("01", _PIX_KEY);
  const body =
    _tlv("00", "01") +
    _tlv("26", mai) +
    _tlv("52", "0000") +
    _tlv("53", "986") +
    _tlv("54", amountBrl) +
    _tlv("58", "BR") +
    _tlv("59", _MERCHANT_NAME.slice(0, 25)) +
    _tlv("60", _MERCHANT_CITY.slice(0, 15)) +
    _tlv("62", _tlv("05", safeTxid)) +
    "6304";
  return body + _crc16(body);
}
// ─────────────────────────────────────────────────────────────────────────────

export class OfferResponseError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "OfferResponseError";
  }
}

export class RespondToRideOfferUseCase {

  async execute(offerId: string, accept: boolean): Promise<{ accepted: boolean; paymentIntent?: { id: string; brCode: string; qrCodeUrl: string } | null }> {

    const offer = await prisma.rideOffer.findUnique({
      where: { id: offerId },
    });

    if (!offer) {
      throw new OfferResponseError("OFFER_NOT_FOUND", "Offer nao encontrada");
    }

    if (offer.status !== "PENDING") {
      throw new OfferResponseError(
        "OFFER_ALREADY_RESPONDED",
        "Offer ja foi respondida com status: " + offer.status
      );
    }

    if (new Date() > offer.expiresAt) {
      throw new OfferResponseError("OFFER_EXPIRED", "Offer ja expirou");
    }

    const now = new Date();

    if (accept) {
      await prisma.$transaction(async (tx) => {
        await tx.rideOffer.update({
          where: { id: offerId },
          data: { status: "ACCEPTED", respondedAt: now },
        });

        await tx.rideOffer.updateMany({
          where: {
            rideRequestId: offer.rideRequestId,
            id: { not: offerId },
            status: "PENDING",
          },
          data: { status: "REJECTED" },
        });

        await tx.rideRequest.update({
          where: { id: offer.rideRequestId },
          data: {
            status: "ACCEPTED",
            selectedDriverId: offer.driverId,
            // Phase 2: clear queue state on terminal accept.
            currentCandidateDriverId: null,
            queueSnapshot: Prisma.DbNull,
          },
        });
      });

      console.log(`✅ Corrida ${offer.rideRequestId} aceita pelo driver ${offer.driverId}`);

      // ── PIX Estático inline — sem chamada HTTP ao PicPay ─────────────────
      // Fase E — preço do passageiro vem da quote (gross, immutable snapshot).
      // Sem quote, mantém o fallback legado (priceOffered/priceEstimated).
      const ride = await prisma.rideRequest.findUnique({
        where: { id: offer.rideRequestId },
        select: { priceOffered: true, priceEstimated: true },
      });
      const quoteCents = await resolveQuoteGrossCents(offer.rideRequestId);
      const amountCents =
        quoteCents ??
        Math.round((ride?.priceOffered ?? ride?.priceEstimated ?? 0) * 100);

      let paymentIntent: { id: string; brCode: string; qrCodeUrl: string } | null = null;

      if (amountCents > 0) {
        let intent = await prisma.paymentIntent.findUnique({
          where: { rideRequestId: offer.rideRequestId },
        });

        const needsQr = !intent || !intent.qrCode || intent.qrCode.includes("qr-code.picpay.com");

        if (!intent) {
          intent = await prisma.paymentIntent.create({
            data: { rideRequestId: offer.rideRequestId, amountCents },
          });
        }

        if (needsQr) {
          const qrCode = _buildStaticPix(amountCents, intent.id);
          const externalId = `static_pix_${intent.id}`;
          console.log("✅ [INLINE PIX — OFFER ACCEPT] EMVCo gerado:", {
            rideId: offer.rideRequestId,
            amountCents,
            qrCodePreview: qrCode.slice(0, 60) + "...",
          });
          intent = await prisma.paymentIntent.update({
            where: { id: intent.id },
            data: { qrCode, externalId, qrCodeImage: "" },
          });
        }

        paymentIntent = { id: intent.id, brCode: intent.qrCode ?? "", qrCodeUrl: "" };
      }
      // ─────────────────────────────────────────────────────────────────────

      return { accepted: true, paymentIntent };

    } else {
      const ride = await prisma.rideRequest.findUnique({
        where: { id: offer.rideRequestId },
        select: {
          status: true,
          scheduledAt: true,
          operationalCutoffAt: true,
          currentDispatchStage: true,
          passenger: { select: { referredByDriverId: true } },
        },
      });

      await prisma.rideOffer.update({
        where: { id: offerId },
        data: { status: "REJECTED", respondedAt: now },
      });

      // Phase 2: append rejecting driver to persisted exclusion list and clear
      // the current candidate pointer atomically so the next dispatchNextCandidate
      // call cannot re-offer to the same driver.
      await prisma.rideRequest.update({
        where: { id: offer.rideRequestId },
        data: {
          excludedDriverIds: { push: offer.driverId },
          currentCandidateDriverId: null,
        },
      });

      logMatchingEvent({
        rideId: offer.rideRequestId,
        event: "OFFER_REJECTED",
        metadata: { driverId: offer.driverId },
      });
      console.log("Driver " + offer.driverId + " rejeitou a corrida " + offer.rideRequestId);

      // Check operational cutoff before redistribution.
      const policy = AcceptancePolicyEngine.computePolicy(ride?.scheduledAt ?? null);
      if (AcceptancePolicyEngine.isBeyondCutoff(new Date(), policy)) {
        logMatchingEvent({
          rideId: offer.rideRequestId,
          event: "OPERATIONAL_CUTOFF_REACHED",
          metadata: { operationalCutoffAt: policy.operationalCutoffAt?.toISOString() },
        });
        await prisma.rideRequest.update({
          where: { id: offer.rideRequestId },
          data: { status: "CANCELLED" },
        });
        return { accepted: false };
      }

      // If owner rejects, move to network dispatch
      if (ride?.currentDispatchStage === "OWNER_DISPATCH") {
        await prisma.rideRequest.update({
          where: { id: offer.rideRequestId },
          data: { currentDispatchStage: "NETWORK_DISPATCH" },
        });
      }

      const matchRide = new MatchRideUseCase();
      const { matched } = await matchRide.dispatchNextCandidate({ rideId: offer.rideRequestId });

      logMatchingEvent({
        rideId: offer.rideRequestId,
        event: "OFFER_REDISTRIBUTED",
        metadata: { matched },
      });

      if (!matched) {
        // A concurrent accept/cancel or another redispatch may already have
        // changed the ride. Absence of this optional recovery transition is
        // idempotent and must not surface as Prisma P2025 / HTTP 500.
        await prisma.rideRequest.updateMany({
          where: {
            id: offer.rideRequestId,
            status: { in: [...MATCHABLE_RIDE_STATUSES] },
            currentCandidateDriverId: null,
          },
          data: { currentDispatchStage: "OWNER_RECOVERY" },
        });
      }
    }

    return { accepted: accept };
  }
}
