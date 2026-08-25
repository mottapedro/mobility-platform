import type { Prisma, RideStatus } from "@prisma/client";
import { prisma } from "../../infra/prisma/client";

const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 20;
const MATCHABLE_RIDE_STATUSES = new Set<RideStatus>([
  "PENDING",
  "MATCHING",
  "WAITING_REFERRAL",
  "WAITING_PARTNER",
  "WAITING_GENERAL",
]);

export type OfferBookStatus =
  | "ACTIVE"
  | "ACCEPTED"
  | "REJECTED"
  | "EXPIRED"
  | "LOST"
  | "UNAVAILABLE";

export type OfferBookOutcomeReason =
  | "ACTIVE_OFFER"
  | "DRIVER_ACCEPTED"
  | "DRIVER_REJECTED"
  | "OFFER_EXPIRED"
  | "ANOTHER_DRIVER_ACCEPTED"
  | "RIDE_UNAVAILABLE";

export interface OfferBookItem {
  offerId: string;
  rideRequestId: string;
  bookStatus: OfferBookStatus;
  createdAt: Date;
  expiresAt: Date;
  respondedAt: Date | null;
  rideStatus: RideStatus;
  scheduledAt: Date | null;
  origin: string;
  destination: string;
  driverReceivableAmountCents: number | null;
  selectedByOtherDriver: boolean;
  outcomeReason: OfferBookOutcomeReason;
  rideDistanceKm: number | null;
  driverToPickupDistanceKm: number | null;
}

export interface OfferBookPage {
  items: OfferBookItem[];
  nextCursor: string | null;
}

export class OfferBookQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfferBookQueryError";
  }
}

type OfferBookRow = Prisma.RideOfferGetPayload<{
  select: {
    id: true;
    rideRequestId: true;
    driverId: true;
    status: true;
    expiresAt: true;
    respondedAt: true;
    createdAt: true;
    driverToPickupDistanceKm: true;
    rideDistanceKm: true;
    driverReceivableAmountCents: true;
    rideRequest: {
      select: {
        status: true;
        selectedDriverId: true;
        currentCandidateDriverId: true;
        scheduledAt: true;
        origin: true;
        destination: true;
      };
    };
  };
}>;

const offerSelect = {
  id: true,
  rideRequestId: true,
  driverId: true,
  status: true,
  expiresAt: true,
  respondedAt: true,
  createdAt: true,
  driverToPickupDistanceKm: true,
  rideDistanceKm: true,
  driverReceivableAmountCents: true,
  rideRequest: {
    select: {
      status: true,
      selectedDriverId: true,
      currentCandidateDriverId: true,
      scheduledAt: true,
      origin: true,
      destination: true,
    },
  },
} satisfies Prisma.RideOfferSelect;

interface CursorPayload {
  createdAt: string;
  id: string;
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id }), "utf8").toString("base64url");
}

function decodeCursor(raw: string | undefined): CursorPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<CursorPayload>;
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string" || !parsed.id) {
      throw new Error("invalid cursor");
    }
    const date = new Date(parsed.createdAt);
    if (Number.isNaN(date.getTime())) throw new Error("invalid cursor date");
    return { createdAt: date.toISOString(), id: parsed.id };
  } catch {
    throw new OfferBookQueryError("cursor inválido");
  }
}

function parseLimit(raw: unknown): number {
  if (raw === undefined) return DEFAULT_PAGE_SIZE;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw new OfferBookQueryError(`limit deve ser um inteiro entre 1 e ${MAX_PAGE_SIZE}`);
  }
  return value;
}

function deriveBookStatus(row: OfferBookRow, authenticatedDriverId: string, now: Date): {
  bookStatus: OfferBookStatus;
  outcomeReason: OfferBookOutcomeReason;
  selectedByOtherDriver: boolean;
} {
  const selectedByOtherDriver = row.rideRequest.selectedDriverId !== null &&
    row.rideRequest.selectedDriverId !== authenticatedDriverId;

  if (row.status === "ACCEPTED" || row.status === "PAID") {
    return {
      bookStatus: "ACCEPTED",
      outcomeReason: "DRIVER_ACCEPTED",
      selectedByOtherDriver: false,
    };
  }

  if (
    row.status === "REJECTED" &&
    row.respondedAt === null &&
    selectedByOtherDriver
  ) {
    return {
      bookStatus: "LOST",
      outcomeReason: "ANOTHER_DRIVER_ACCEPTED",
      selectedByOtherDriver: true,
    };
  }

  if (row.status === "REJECTED") {
    return {
      bookStatus: "REJECTED",
      outcomeReason: row.respondedAt ? "DRIVER_REJECTED" : "RIDE_UNAVAILABLE",
      selectedByOtherDriver,
    };
  }

  if (row.status === "EXPIRED" || (row.status === "PENDING" && row.expiresAt <= now)) {
    return {
      bookStatus: "EXPIRED",
      outcomeReason: "OFFER_EXPIRED",
      selectedByOtherDriver,
    };
  }

  if (row.status === "PENDING" && selectedByOtherDriver) {
    return {
      bookStatus: "LOST",
      outcomeReason: "ANOTHER_DRIVER_ACCEPTED",
      selectedByOtherDriver: true,
    };
  }

  if (
    row.status === "PENDING" &&
    (!MATCHABLE_RIDE_STATUSES.has(row.rideRequest.status) ||
      (row.rideRequest.currentCandidateDriverId !== null &&
        row.rideRequest.currentCandidateDriverId !== authenticatedDriverId))
  ) {
    return {
      bookStatus: "UNAVAILABLE",
      outcomeReason: "RIDE_UNAVAILABLE",
      selectedByOtherDriver,
    };
  }

  return {
    bookStatus: "ACTIVE",
    outcomeReason: "ACTIVE_OFFER",
    selectedByOtherDriver,
  };
}

function toDto(row: OfferBookRow, authenticatedDriverId: string, now: Date): OfferBookItem {
  const derived = deriveBookStatus(row, authenticatedDriverId, now);
  return {
    offerId: row.id,
    rideRequestId: row.rideRequestId,
    bookStatus: derived.bookStatus,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    respondedAt: row.respondedAt,
    rideStatus: row.rideRequest.status,
    scheduledAt: row.rideRequest.scheduledAt,
    origin: row.rideRequest.origin,
    destination: row.rideRequest.destination,
    driverReceivableAmountCents: row.driverReceivableAmountCents,
    selectedByOtherDriver: derived.selectedByOtherDriver,
    outcomeReason: derived.outcomeReason,
    rideDistanceKm: row.rideDistanceKm,
    driverToPickupDistanceKm: row.driverToPickupDistanceKm,
  };
}

export class OfferBookReadService {
  async listForDriver(
    authenticatedDriverId: string,
    input: { limit?: unknown; cursor?: string } = {},
  ): Promise<OfferBookPage> {
    const limit = parseLimit(input.limit);
    const cursor = decodeCursor(input.cursor);
    const cursorDate = cursor ? new Date(cursor.createdAt) : null;
    const cursorId = cursor?.id ?? null;

    const cursorWhere: Prisma.RideOfferWhereInput | undefined = cursorDate && cursorId
      ? {
          OR: [
            { createdAt: { lt: cursorDate } },
            { createdAt: cursorDate, id: { lt: cursorId } },
          ],
        }
      : undefined;

    const rows = await prisma.rideOffer.findMany({
      where: {
        driverId: authenticatedDriverId,
        ...(cursorWhere ?? {}),
      },
      select: offerSelect,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    const hasNext = rows.length > limit;
    const pageRows = (hasNext ? rows.slice(0, limit) : rows) as OfferBookRow[];
    const now = new Date();

    return {
      items: pageRows.map((row) => toDto(row, authenticatedDriverId, now)),
      nextCursor: hasNext
        ? encodeCursor(pageRows[pageRows.length - 1].createdAt, pageRows[pageRows.length - 1].id)
        : null,
    };
  }
}

export const offerBookReadService = new OfferBookReadService();
