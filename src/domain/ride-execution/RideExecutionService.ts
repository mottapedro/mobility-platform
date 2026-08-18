/**
 * Domain Service: RideExecutionService
 *
 * Stage 2.C — Handles the in-flight ride lifecycle transitions that are not
 * already covered by FinalizeRideService (STARTED → COMPLETED).
 *
 * Responsibilities:
 *   - `start`  : ACCEPTED → IN_PROGRESS  (driver picks up passenger)
 *   - `cancel` : any cancellable state → CANCELLED
 *
 * Both operations are idempotent:
 *   - `start` on an already IN_PROGRESS ride returns { started: false }.
 *   - `cancel` on an already CANCELLED ride returns { cancelled: false }.
 *
 * Throws `RideLifecycleError` for invalid state transitions.
 */

import type { RideRequest } from "@prisma/client";
import { RideLifecycle, RideStatus, isValidRideTransition } from "../../shared/enums";
import { prisma } from "../../infra/prisma/client";
import { RideLifecycleError } from "./RideLifecycleError";

type Db = Pick<typeof prisma, "rideRequest">;

export interface StartRideResult {
  ride: RideRequest;
  started: boolean;
}

export interface CancelRideResult {
  ride: RideRequest;
  cancelled: boolean;
}

export interface RideExecutionDeps {
  db?: Db;
}

export async function start(
  rideId: string,
  deps: RideExecutionDeps = {}
): Promise<StartRideResult> {
  const db = deps.db ?? prisma;

  const ride = await db.rideRequest.findUnique({ where: { id: rideId } });
  if (!ride) {
    throw new RideLifecycleError(`Ride ${rideId} not found`);
  }

  // Idempotent: already started
  if (ride.status === RideStatus.IN_PROGRESS) {
    return { ride, started: false };
  }

  if (!isValidRideTransition(ride.status as RideLifecycle, RideLifecycle.IN_PROGRESS)) {
    throw new RideLifecycleError(
      `Cannot start ride ${rideId}: invalid transition from ${ride.status} → IN_PROGRESS`
    );
  }

  const updated = await db.rideRequest.update({
    where: { id: rideId },
    data: { status: RideStatus.IN_PROGRESS },
  });

  return { ride: updated, started: true };
}

export async function cancel(
  rideId: string,
  deps: RideExecutionDeps = {}
): Promise<CancelRideResult> {
  const db = deps.db ?? prisma;

  const ride = await db.rideRequest.findUnique({ where: { id: rideId } });
  if (!ride) {
    throw new RideLifecycleError(`Ride ${rideId} not found`);
  }

  // Idempotent: already cancelled
  if (ride.status === RideStatus.CANCELLED) {
    return { ride, cancelled: false };
  }

  if (!isValidRideTransition(ride.status as RideLifecycle, RideLifecycle.CANCELLED)) {
    throw new RideLifecycleError(
      `Cannot cancel ride ${rideId}: invalid transition from ${ride.status} → CANCELLED`
    );
  }

  const updated = await db.rideRequest.update({
    where: { id: rideId },
    data: { status: RideStatus.CANCELLED },
  });

  return { ride: updated, cancelled: true };
}

export const RideExecutionService = { start, cancel };