/**
 * Application Service: CreateOfferService
 *
 * Stage 2.B leaf service. Extracts the private `createOffer` helper from
 * MatchRideUseCase into a standalone, testable application service.
 *
 * Behavior preserved:
 *   - Attempts to create a RideOffer (PENDING) row for (rideRequestId, driverId).
 *   - Idempotent via the @@unique([rideRequestId, driverId]) constraint:
 *     if the offer already exists, returns it with created=false instead of
 *     letting the unique violation escape (matches the previous catch-and-swallow).
 *   - Optionally emits OFFER_CREATED (only on first creation) when a bus is provided.
 */

import type { RideOffer } from "@prisma/client";
import { DomainEventType } from "../../shared/enums";
import { prisma } from "../../infra/prisma/client";
import { EventBus, recordAndPublish } from "../../domain/shared/events/EventBus";

type Db = Pick<typeof prisma, "rideOffer" | "domainEvent">;

export interface CreateOfferInput {
  rideRequestId: string;
  driverId: string;
  expiresAt: Date;
}

export interface CreateOfferResult {
  offer: RideOffer;
  created: boolean;
}

export interface CreateOfferDeps {
  db?: Db;
  bus?: EventBus;
}

export async function execute(
  input: CreateOfferInput,
  deps: CreateOfferDeps = {}
): Promise<CreateOfferResult> {
  const db = deps.db ?? prisma;

  let offer: RideOffer;
  try {
    offer = await db.rideOffer.create({
      data: {
        rideRequestId: input.rideRequestId,
        driverId: input.driverId,
        expiresAt: input.expiresAt,
      },
    });
  } catch (err) {
    // Tolerate @@unique([rideRequestId, driverId]) violation by re-reading the
    // pre-existing row and reporting created=false (preserves the original
    // catch-and-swallow semantics from MatchRideUseCase).
    const existing = await db.rideOffer.findUnique({
      where: {
        rideRequestId_driverId: {
          rideRequestId: input.rideRequestId,
          driverId: input.driverId,
        },
      },
    });
    if (existing) {
      return { offer: existing, created: false };
    }
    throw err;
  }

  if (deps.bus) {
    await recordAndPublish(
      deps.bus,
      {
        type: DomainEventType.OFFER_CREATED,
        aggregateType: "RideOffer",
        aggregateId: offer.id,
        payload: {
          rideRequestId: input.rideRequestId,
          driverId: input.driverId,
          expiresAt: input.expiresAt.toISOString(),
        },
      },
      db
    );
  }

  return { offer, created: true };
}

export const CreateOfferService = { execute };
