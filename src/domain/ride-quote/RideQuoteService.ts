import { RideQuote } from "@prisma/client";
import { loadRideQuoteTtlMs } from "../../config/rideQuote";
import { prisma } from "../../infra/prisma/client";

export interface IssueQuoteInput {
  rideRequestId: string;
  pricingDriverId: string;
  originMLat: number;
  originMLng: number;
  originMSource: string;
  distanceMtoAKm: number;
  distanceAtoBKm: number;
  legCostMtoACents: number;
  legPriceAtoBCents: number;
  grossFinalCents: number;
  revenuePolicyId?: string | null;
  revenuePolicyVersion?: number | null;
  driverReceivableAmountCents: number;
}

export type ConfirmQuoteResult =
  | { outcome: "AGREED"; quote: RideQuote; alreadyAgreed: boolean }
  | { outcome: "EXPIRED"; quote: RideQuote }
  | { outcome: "VERSION_CONFLICT"; quote: RideQuote }
  | { outcome: "NOT_FOUND" };

export interface ConfirmQuoteInput {
  rideRequestId: string;
  pricingDriverId: string;
  expectedVersion: number;
  now?: Date;
}

const LIVE_QUOTE_STATUSES = ["QUOTED", "AGREED"] as const;

/**
 * Resolve o preço autoritativo pago pelo passageiro (gross da quote viva) em
 * centavos. Fonte única após a emissão da quote (Fase E): o PaymentIntent e o
 * Settlement leem este valor — nunca recalculam o preço.
 * Retorna null quando a corrida não possui quote (fluxo clássico).
 */
export async function resolveQuoteGrossCents(
  rideRequestId: string,
): Promise<number | null> {
  const quote = await prisma.rideQuote.findFirst({
    where: {
      rideRequestId,
      status: { in: [...LIVE_QUOTE_STATUSES] },
    },
    orderBy: { createdAt: "desc" },
    select: { grossFinalCents: true },
  });
  return quote?.grossFinalCents ?? null;
}

/**
 * Contrato persistente de precificação (Fase D).
 *
 * - `issueQuote`: cria QUOTED com version=1 e expiresAt = createdAt + TTL (15min).
 *   Idempotente: se já existir quote viva (QUOTED|AGREED) para (corrida, driver),
 *   retorna a existente — a partial unique index respalda isso no banco.
 * - `confirmQuote`: confirma SOMENTE com status=QUOTED, version esperada e
 *   expiresAt > now, via update CAS atômico. Uma quote já AGREED retorna o
 *   mesmo contrato idempotentemente. Quote expirada transita para EXPIRED e
 *   nunca confirma.
 *
 * Nesta fase NENHUM matching/redispatch é iniciado a partir daqui e o
 * Settlement não é alterado — a integração da quote com a oferta é a Fase E.
 */
export class RideQuoteService {
  async issueQuote(input: IssueQuoteInput): Promise<RideQuote> {
    const now = new Date();
    const ttlMs = loadRideQuoteTtlMs();

    const existing = await prisma.rideQuote.findFirst({
      where: {
        rideRequestId: input.rideRequestId,
        pricingDriverId: input.pricingDriverId,
        status: { in: [...LIVE_QUOTE_STATUSES] },
      },
      orderBy: { createdAt: "desc" },
    });
    if (existing) {
      return existing;
    }

    return prisma.rideQuote.create({
      data: {
        rideRequestId: input.rideRequestId,
        pricingDriverId: input.pricingDriverId,
        originMLat: input.originMLat,
        originMLng: input.originMLng,
        originMSource: input.originMSource,
        distanceMtoAKm: input.distanceMtoAKm,
        distanceAtoBKm: input.distanceAtoBKm,
        legCostMtoACents: input.legCostMtoACents,
        legPriceAtoBCents: input.legPriceAtoBCents,
        grossFinalCents: input.grossFinalCents,
        revenuePolicyId: input.revenuePolicyId ?? null,
        revenuePolicyVersion: input.revenuePolicyVersion ?? null,
        driverReceivableAmountCents: input.driverReceivableAmountCents,
        version: 1,
        status: "QUOTED",
        createdAt: now,
        expiresAt: new Date(now.getTime() + ttlMs),
      },
    });
  }

  async confirmQuote(input: ConfirmQuoteInput): Promise<ConfirmQuoteResult> {
    const now = input.now ?? new Date();

    const quote = await prisma.rideQuote.findFirst({
      where: {
        rideRequestId: input.rideRequestId,
        pricingDriverId: input.pricingDriverId,
      },
      orderBy: { createdAt: "desc" },
    });

    if (!quote) {
      return { outcome: "NOT_FOUND" };
    }

    // Retry idempotente: contrato já firmado retorna o mesmo AGREED.
    if (quote.status === "AGREED") {
      return { outcome: "AGREED", quote, alreadyAgreed: true };
    }

    if (quote.status === "EXPIRED") {
      return { outcome: "EXPIRED", quote };
    }

    if (quote.expiresAt.getTime() <= now.getTime()) {
      await prisma.rideQuote.updateMany({
        where: { id: quote.id, status: "QUOTED" },
        data: { status: "EXPIRED" },
      });
      return { outcome: "EXPIRED", quote: { ...quote, status: "EXPIRED" } };
    }

    if (quote.version !== input.expectedVersion) {
      return { outcome: "VERSION_CONFLICT", quote };
    }

    const updated = await prisma.rideQuote.updateMany({
      where: {
        id: quote.id,
        status: "QUOTED",
        version: input.expectedVersion,
        expiresAt: { gt: now },
      },
      data: { status: "AGREED", version: { increment: 1 }, agreedAt: now },
    });

    if (updated.count === 1) {
      const agreed = await prisma.rideQuote.findUniqueOrThrow({
        where: { id: quote.id },
      });
      return { outcome: "AGREED", quote: agreed, alreadyAgreed: false };
    }

    // CAS perdeu para um concorrente — re-leitura resolve o estado final.
    const latest = await prisma.rideQuote.findUniqueOrThrow({
      where: { id: quote.id },
    });
    if (latest.status === "AGREED") {
      return { outcome: "AGREED", quote: latest, alreadyAgreed: true };
    }
    if (latest.status === "EXPIRED") {
      return { outcome: "EXPIRED", quote: latest };
    }
    return { outcome: "VERSION_CONFLICT", quote: latest };
  }
}