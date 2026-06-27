import { ActorType } from "../../shared/enums";
import { prisma } from "../../infra/prisma/client";
import { resolveDriverRoot } from "../referral-network/DriverRootResolverService";

type Db = typeof prisma;

export interface OwnershipProjectionResult {
  passengerId?: string;
  rideRequestId?: string;
  settlementId?: string;
  rootDriverId: string;
}

export interface ReconciliationSummary {
  passengersChecked: number;
  passengersUpdated: number;
  ridesChecked: number;
  ridesUpdated: number;
  settlementsChecked: number;
  settlementsUpdated: number;
}

export class OwnershipProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnershipProjectionError";
  }
}

/**
 * RootOwnershipProjectionService
 *
 * Single authority for projecting economic ownership onto denormalized columns.
 *
 * Invariants:
 *   - Passenger.rootDriverId always matches ReferralRelationship.rootDriverId.
 *   - RideRequest.rootDriverId always matches Passenger.rootDriverId at ride time.
 *   - Settlement.rootDriverId is a frozen snapshot copied from RideRequest.rootDriverId.
 *
 * All mutations that can affect ownership must call this service synchronously.
 */
export const RootOwnershipProjectionService = {
  async projectPassengerOwnership(
    passengerId: string,
    db: Db = prisma
  ): Promise<OwnershipProjectionResult> {
    const passenger = await db.passenger.findUnique({
      where: { id: passengerId },
      select: { id: true, referredByDriverId: true, referredByPassengerId: true },
    });
    if (!passenger) {
      throw new OwnershipProjectionError(`Passenger ${passengerId} not found`);
    }

    const rootDriverId = await resolveDriverRoot(ActorType.PASSENGER, passengerId, db);
    if (!rootDriverId) {
      throw new OwnershipProjectionError(
        `Could not resolve rootDriverId for passenger ${passengerId}`
      );
    }

    await db.passenger.update({
      where: { id: passengerId },
      data: { rootDriverId },
    });

    return { passengerId, rootDriverId };
  },

  async projectRideOwnership(
    rideRequestId: string,
    db: Db = prisma
  ): Promise<OwnershipProjectionResult> {
    const ride = await db.rideRequest.findUnique({
      where: { id: rideRequestId },
      select: { id: true, passengerId: true },
    });
    if (!ride) {
      throw new OwnershipProjectionError(`RideRequest ${rideRequestId} not found`);
    }

    const passenger = await db.passenger.findUnique({
      where: { id: ride.passengerId },
      select: { id: true, rootDriverId: true },
    });
    if (!passenger) {
      throw new OwnershipProjectionError(
        `Passenger ${ride.passengerId} for ride ${rideRequestId} not found`
      );
    }

    let rootDriverId = passenger.rootDriverId;
    if (!rootDriverId) {
      const projected = await RootOwnershipProjectionService.projectPassengerOwnership(
        passenger.id,
        db
      );
      rootDriverId = projected.rootDriverId;
    }
    await db.rideRequest.update({
      where: { id: rideRequestId },
      data: { rootDriverId },
    });

    return { rideRequestId, rootDriverId };
  },

  async projectSettlementOwnership(
    settlementId: string,
    db: Db = prisma
  ): Promise<OwnershipProjectionResult> {
    const settlement = await db.settlement.findUnique({
      where: { id: settlementId },
      select: { id: true, rideRequestId: true, rootDriverId: true },
    });
    if (!settlement) {
      throw new OwnershipProjectionError(`Settlement ${settlementId} not found`);
    }

    const ride = await db.rideRequest.findUnique({
      where: { id: settlement.rideRequestId },
      select: { id: true, rootDriverId: true },
    });
    if (!ride) {
      throw new OwnershipProjectionError(
        `RideRequest ${settlement.rideRequestId} for settlement ${settlementId} not found`
      );
    }

    let rootDriverId = ride.rootDriverId;
    if (!rootDriverId) {
      const projected = await RootOwnershipProjectionService.projectRideOwnership(ride.id, db);
      rootDriverId = projected.rootDriverId;
    }
    await db.settlement.update({
      where: { id: settlementId },
      data: { rootDriverId },
    });

    return { settlementId, rootDriverId };
  },

  async reconcileOwnership(db: Db = prisma): Promise<ReconciliationSummary> {
    const summary: ReconciliationSummary = {
      passengersChecked: 0,
      passengersUpdated: 0,
      ridesChecked: 0,
      ridesUpdated: 0,
      settlementsChecked: 0,
      settlementsUpdated: 0,
    };

    const passengers = await db.passenger.findMany({
      select: { id: true, rootDriverId: true },
    });
    summary.passengersChecked = passengers.length;
    for (const passenger of passengers) {
      try {
        const result = await RootOwnershipProjectionService.projectPassengerOwnership(
          passenger.id,
          db
        );
        if (result.rootDriverId !== passenger.rootDriverId) {
          summary.passengersUpdated++;
        }
      } catch (err) {
        console.warn("[Ownership] reconcile passenger skipped", passenger.id, err);
      }
    }

    const rides = await db.rideRequest.findMany({
      select: { id: true, rootDriverId: true },
    });
    summary.ridesChecked = rides.length;
    for (const ride of rides) {
      try {
        const result = await RootOwnershipProjectionService.projectRideOwnership(ride.id, db);
        if (result.rootDriverId !== ride.rootDriverId) {
          summary.ridesUpdated++;
        }
      } catch (err) {
        console.warn("[Ownership] reconcile ride skipped", ride.id, err);
      }
    }

    const settlements = await db.settlement.findMany({
      select: { id: true, rootDriverId: true },
    });
    summary.settlementsChecked = settlements.length;
    for (const settlement of settlements) {
      try {
        const result = await RootOwnershipProjectionService.projectSettlementOwnership(
          settlement.id,
          db
        );
        if (result.rootDriverId !== settlement.rootDriverId) {
          summary.settlementsUpdated++;
        }
      } catch (err) {
        console.warn("[Ownership] reconcile settlement skipped", settlement.id, err);
      }
    }

    return summary;
  },

  async assertOwnershipIntegrity(db: Db = prisma): Promise<void> {
    const violations: string[] = [];

    const passengers = await db.passenger.findMany({
      select: { id: true, rootDriverId: true },
    });
    for (const passenger of passengers) {
      if (!passenger.rootDriverId) {
        violations.push(`Passenger ${passenger.id} missing rootDriverId`);
        continue;
      }
      const expected = await resolveDriverRoot(ActorType.PASSENGER, passenger.id, db).catch(
        () => null
      );
      if (expected !== passenger.rootDriverId) {
        violations.push(
          `Passenger ${passenger.id} rootDriverId ${passenger.rootDriverId} !== expected ${expected}`
        );
      }
    }

    const rides = await db.rideRequest.findMany({
      select: { id: true, passengerId: true, rootDriverId: true },
    });
    for (const ride of rides) {
      if (!ride.rootDriverId) {
        violations.push(`RideRequest ${ride.id} missing rootDriverId`);
        continue;
      }
      const passenger = await db.passenger.findUnique({
        where: { id: ride.passengerId },
        select: { rootDriverId: true },
      });
      if (passenger?.rootDriverId !== ride.rootDriverId) {
        violations.push(
          `RideRequest ${ride.id} rootDriverId ${ride.rootDriverId} !== passenger ${passenger?.rootDriverId}`
        );
      }
    }

    const settlements = await db.settlement.findMany({
      select: { id: true, rideRequestId: true, rootDriverId: true },
    });
    for (const settlement of settlements) {
      const ride = await db.rideRequest.findUnique({
        where: { id: settlement.rideRequestId },
        select: { rootDriverId: true },
      });
      if (ride?.rootDriverId !== settlement.rootDriverId) {
        violations.push(
          `Settlement ${settlement.id} rootDriverId ${settlement.rootDriverId} !== ride ${ride?.rootDriverId}`
        );
      }
    }

    if (violations.length > 0) {
      throw new OwnershipProjectionError(
        `Ownership integrity violations:\n${violations.join("\n")}`
      );
    }
  },
};
