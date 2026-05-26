/**
 * Application Service: FinalizeRideService
 *
 * Stage 2.B service. Transitions a ride from IN_PROGRESS -> COMPLETED,
 * gating the change through the canonical RIDE_LIFECYCLE_TRANSITIONS matrix
 * and emitting the RIDE_FINALIZED domain event exactly once.
 *
 * This is the operational handoff between the driver's "I finished the trip"
 * action and the payment/settlement pipeline (which later transitions
 * COMPLETED -> PAID via SettlementService).
 *
 * Behavior:
 *   - IN_PROGRESS -> updates status to COMPLETED, optionally captures
 *     distanceKm / durationMin / priceOffered (final metrics), emits
 *     RIDE_FINALIZED. Returns { ride, finalized: true }.
 *   - Already COMPLETED (or PAID) -> idempotent no-op, returns the existing
 *     row with { finalized: false } and emits nothing.
 *   - Any other source status -> throws (matches isValidRideTransition).
 *
 * Note: RideLifecycleError as a typed error class is a Stage 2.C concern;
 * for now invalid transitions throw a plain Error with a stable message
 * prefix ("RideLifecycle:") so callers/tests can pattern-match.
 */

import type { RideRequest } from "@prisma/client";
import {
  DomainEventType,
  RideLifecycle,
  RideStatus,
  isValidRideTransition,
} from "../../shared/enums";
import { prisma } from "../../infra/prisma/client";
import { EventBus, recordAndPublish } from "../../domain/shared/events/EventBus";

type Db = Pick<typeof prisma, "rideRequest" | "domainEvent">;

export interface FinalizeRideInput {
  rideRequestId: string;
  distanceKm?: number;
  durationMin?: number;
  finalPriceCents?: number;
}

export interface FinalizeRideResult {
  ride: RideRequest;
  finalized: boolean;
}

export interface FinalizeRideDeps {
  db?: Db;
  bus?: EventBus;
}

export async function execute(
  input: FinalizeRideInput,
  deps: FinalizeRideDeps = {}
): Promise<FinalizeRideResult> {
  const db = deps.db ?? prisma;

  const ride = await db.rideRequest.findUnique({
    where: { id: input.rideRequestId },
  });
  if (!ride) {
    throw new Error(`RideLifecycle: ride ${input.rideRequestId} not found`);
  }

  // Idempotent terminal states: COMPLETED is the target; PAID is a downstream
  // terminal state reached via SettlementService. Both mean "already finalized".
  if (ride.status === RideStatus.COMPLETED || ride.status === RideStatus.PAID) {
    return { ride, finalized: false };
  }

  if (!isValidRideTransition(ride.status as RideLifecycle, RideLifecycle.COMPLETED)) {
    throw new Error(
      `RideLifecycle: cannot finalize ride ${input.rideRequestId} from status=${ride.status}`
    );
  }

  const updated = await db.rideRequest.update({
    where: { id: input.rideRequestId },
    data: {
      status: RideStatus.COMPLETED,
      ...(input.distanceKm !== undefined ? { distanceKm: input.distanceKm } : {}),
      ...(input.durationMin !== undefined ? { durationMin: input.durationMin } : {}),
      ...(input.finalPriceCents !== undefined
        ? { priceOffered: input.finalPriceCents / 100 }
        : {}),
    },
  });

  if (deps.bus) {
    await recordAndPublish(
      deps.bus,
      {
        type: DomainEventType.RIDE_FINALIZED,
        aggregateType: "RideRequest",
        aggregateId: updated.id,
        payload: {
          rideRequestId: updated.id,
          driverId: updated.selectedDriverId,
          passengerId: updated.passengerId,
          distanceKm: updated.distanceKm,
          durationMin: updated.durationMin,
          priceOffered: updated.priceOffered,
        },
      },
      db
    );
  }

  return { ride: updated, finalized: true };
}

export const FinalizeRideService = { execute };
